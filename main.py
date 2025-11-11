import json
from typing import Dict, Any, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import aiosqlite
import os

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(APP_DIR, "chat.db")

app = FastAPI(title="Cosmic Chat")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=os.path.join(APP_DIR, "static")), name="static")

# rooms: { room_id: { "password": str, "clients": set[WebSocket], "names": set[str] } }
rooms: Dict[str, Dict[str, Any]] = {}

CREATE_MESSAGES = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    mtype TEXT NOT NULL DEFAULT 'text',
    message TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    encrypted INTEGER NOT NULL DEFAULT 0,
    ts TEXT NOT NULL
);
"""

INSERT_MESSAGE = """
INSERT INTO messages (room_id, sender, mtype, message, filename, encrypted, ts)
VALUES (?, ?, ?, ?, ?, ?, ?);
"""

SELECT_MESSAGES = """
SELECT room_id, sender, mtype, message, filename, encrypted, ts
FROM messages
WHERE room_id = ?
ORDER BY id DESC
LIMIT ?;
"""

@app.on_event("startup")
async def startup():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(CREATE_MESSAGES)
        await db.commit()

@app.get("/")
async def index():
    return FileResponse(os.path.join(APP_DIR, "static", "index.html"))

@app.get("/health")
async def health():
    return {"ok": True}

@app.get("/history/{room_id}")
async def history(room_id: str, limit: int = 50):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(SELECT_MESSAGES, (room_id, limit))
        rows = await cur.fetchall()
        payload = [dict(r) for r in rows][::-1]
    return {"messages": payload}

def get_or_create_room(room_id: str, password: str | None):
    room = rooms.get(room_id)
    if room is None:
        rooms[room_id] = {"password": password or "", "clients": set(), "names": set()}
        return rooms[room_id]
    if room["password"] and password != room["password"]:
        raise HTTPException(status_code=403, detail="Invalid room password.")
    if not room["password"] and password:
        room["password"] = password
    return room

async def broadcast(room_id: str, message: str, exclude: WebSocket | None = None):
    room = rooms.get(room_id)
    if not room:
        return
    dead: List[WebSocket] = []
    for ws in list(room["clients"]):
        if exclude is not None and ws is exclude:
            continue
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        room["clients"].discard(ws)

async def persist_message(room_id: str, sender: str, mtype: str, message: str, filename: str, encrypted: int, ts: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(INSERT_MESSAGE, (room_id, sender, mtype, message, filename, encrypted, ts))
        await db.commit()

@app.websocket("/ws/{room_id}")
async def ws_endpoint(websocket: WebSocket, room_id: str, name: str = Query(...), password: str = Query(default="")):
    await websocket.accept()
    try:
        room = get_or_create_room(room_id, password)
    except HTTPException:
        await websocket.send_text(json.dumps({"type": "error", "message": "Invalid room password"}))
        await websocket.close()
        return

    room["clients"].add(websocket)
    room["names"].add(name)

    # send current users list
    users_payload = json.dumps({"type": "users", "list": sorted(room["names"])})
    await broadcast(room_id, users_payload, exclude=None)

    # presence join
    await broadcast(room_id, json.dumps({"type": "presence", "event": "join", "name": name}), exclude=websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = {"type": "message", "text": raw, "ts": "", "encrypted": 0}

            t = data.get("type", "message")
            if t == "typing":
                await broadcast(room_id, json.dumps({"type": "typing", "name": name}), exclude=websocket)
                continue

            if t == "seen":
                await broadcast(room_id, json.dumps({"type": "seen", "messageId": data.get("messageId"), "by": name}), exclude=websocket)
                continue

            if t == "message":
                text = data.get("text", "")
                ts = data.get("ts", "")
                encrypted = 1 if data.get("encrypted", 0) else 0
                message_id = data.get("messageId", "")
                payload = json.dumps({
                    "type": "message",
                    "name": name,
                    "text": text,
                    "ts": ts,
                    "encrypted": encrypted,
                    "messageId": message_id,
                })
                await persist_message(room_id, name, "text", text, "", encrypted, ts)
                await broadcast(room_id, payload, exclude=websocket)
                continue

            if t == "file":
                filename = data.get("filename", "file")
                dataurl = data.get("data", "")
                ts = data.get("ts", "")
                encrypted = 1 if data.get("encrypted", 0) else 0
                message_id = data.get("messageId", "")
                payload = json.dumps({
                    "type": "file",
                    "name": name,
                    "filename": filename,
                    "data": dataurl,
                    "ts": ts,
                    "encrypted": encrypted,
                    "messageId": message_id,
                })
                await persist_message(room_id, name, "file", dataurl, filename, encrypted, ts)
                await broadcast(room_id, payload, exclude=websocket)
                continue

    except WebSocketDisconnect:
        pass
    finally:
        if websocket in room["clients"]:
            room["clients"].remove(websocket)
        if name in room["names"]:
            room["names"].remove(name)
        await broadcast(room_id, json.dumps({"type": "users", "list": sorted(room["names"])}))
        await broadcast(room_id, json.dumps({"type": "presence", "event": "leave", "name": name}))
        if not room["clients"]:
            rooms.pop(room_id, None)