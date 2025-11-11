const $ = (q) => document.querySelector(q);
const messagesEl = $("#messages");
const typingEl = $("#typing");
const roomTitle = $("#room-title");
const presenceEl = $("#presence");
const usersListEl = $("#users-list");
const messageInput = $("#message");

let ws = null;
let state = { room:"", name:"", password:"", e2e:false, key:null, typingTimeout:null, myMsgs:new Map() };

function tsNow(){ return new Date().toISOString(); }
function fmtTs(ts){ try{ return new Date(ts).toLocaleTimeString(); }catch{return ""}}

async function deriveKey(password, room){
  const enc = new TextEncoder();
  const salt = enc.encode("cosmic-chat:"+room);
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2", salt, iterations:100000, hash:"SHA-256"}, keyMaterial, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]);
}
async function encryptText(key, plaintext){
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, enc.encode(plaintext));
  const buf = new Uint8Array(iv.length + new Uint8Array(ct).length);
  buf.set(iv,0); buf.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...buf));
}
async function decryptText(key, b64){
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = raw.slice(0,12); const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({name:"AES-GCM", iv}, key, ct);
  return new TextDecoder().decode(pt);
}

function el(tag, cls){ const d=document.createElement(tag); if(cls) d.className=cls; return d; }
function appendTextBubble({name, text, ts, self=false, id=null}){
  const msg = el("div", "msg"+(self?" self":""));
  const bubble = el("div","bubble");
  const meta = el("div","meta"); meta.textContent = `${name} • ${fmtTs(ts)}`;
  const body = el("div"); body.textContent = text;
  const seen = el("div","badge"); seen.dataset.badge="seen"; seen.textContent="";
  bubble.append(meta, body, seen); msg.append(bubble);
  messagesEl.append(msg); messagesEl.scrollTop = messagesEl.scrollHeight;
  if(self && id){ state.myMsgs.set(id, seen); }
}
function appendFileBubble({name, data, filename, ts, self=false, id=null}){
  const msg = el("div", "msg"+(self?" self":""));
  const bubble = el("div","bubble file-card");
  const meta = el("div","meta"); meta.textContent = `${name} • ${fmtTs(ts)}`;
  const body = el("div");
  if (data.startsWith("data:image/")){ const img = new Image(); img.src=data; img.alt=filename; img.loading="lazy"; body.append(img); }
  else { const a = el("a"); a.href=data; a.download=filename; a.textContent=`Download ${filename}`; body.append(a); }
  const seen = el("div","badge"); seen.dataset.badge="seen"; seen.textContent="";
  bubble.append(meta, body, seen); msg.append(bubble);
  messagesEl.append(msg); messagesEl.scrollTop = messagesEl.scrollHeight;
  if(self && id){ state.myMsgs.set(id, seen); }
}
function updateUsers(list){ usersListEl.textContent = "Active stars: " + (list.join(", ") || "—"); }
function notify(title, body){ if (document.hidden && Notification.permission === "granted") new Notification(title, { body }); }

$("#join").addEventListener("click", async () => {
  state.room = $("#room").value.trim();
  state.name = $("#name").value.trim();
  state.password = $("#password").value;
  state.e2e = $("#use-e2e").checked;
  if (!state.room || !state.name){ alert("Room and Nickname required."); return; }
  if (state.e2e && !state.password){ alert("Set a shared password for E2E."); return; }
  if (state.e2e){ state.key = await deriveKey(state.password, state.room); }

  $("#join-card").classList.add("hidden");
  $("#chat-card").classList.remove("hidden");
  roomTitle.textContent = `Room ${state.room}`;
  if (Notification.permission !== "granted") Notification.requestPermission();

  // history
  try{
    const res = await fetch(`/history/${encodeURIComponent(state.room)}?limit=60`);
    const data = await res.json();
    for(const m of data.messages){
      if (m.mtype === "file"){
        appendFileBubble({name:m.sender, data:m.message, filename:m.filename, ts:m.ts, self:m.sender===state.name});
      } else {
        let text = m.message;
        if (m.encrypted){ text = state.key ? await decryptMaybe(state.key, text) : "[Encrypted message]"; }
        appendTextBubble({name:m.sender, text, ts:m.ts, self:m.sender===state.name});
      }
    }
  }catch(e){ console.error(e); }

  const qs = new URLSearchParams({ name: state.name, password: state.password || "" });
  ws = new WebSocket(`ws://${location.host}/ws/${encodeURIComponent(state.room)}?${qs.toString()}`);
  ws.onmessage = async (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "users") updateUsers(data.list);
    else if (data.type === "presence"){ presenceEl.textContent = `${data.name} ${data.event}`; setTimeout(()=>presenceEl.textContent="",1200); }
    else if (data.type === "typing"){ typingEl.classList.remove("hidden"); clearTimeout(state.typingTimeout); state.typingTimeout=setTimeout(()=>typingEl.classList.add("hidden"), 800); }
    else if (data.type === "message"){
      let text = data.text;
      if (data.encrypted){ text = state.key ? await decryptMaybe(state.key, text) : "[Encrypted message]"; }
      appendTextBubble({name:data.name, text, ts:data.ts, self:false, id:data.messageId});
      notify(data.name, text); ws.send(JSON.stringify({type:"seen", messageId:data.messageId}));
    } else if (data.type === "file"){
      appendFileBubble({name:data.name, data:data.data, filename:data.filename, ts:data.ts, self:false, id:data.messageId});
      notify(data.name, `Sent file: ${data.filename}`); ws.send(JSON.stringify({type:"seen", messageId:data.messageId}));
    } else if (data.type === "seen"){
      const el = state.myMsgs.get(data.messageId); if (el) el.textContent = "✨ seen";
    } else if (data.type === "error"){ alert(data.message || "Error"); }
  };
});
async function decryptMaybe(key, text){ try{ return await decryptText(key, text); }catch{return "[Encrypted]" } }

async function sendMessage(){
  let text = messageInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const id = crypto.randomUUID(); const ts = tsNow();
  let payload = { type:"message", text, ts, encrypted:0, messageId:id };
  if (state.e2e && state.key){ payload.text = await encryptText(state.key, text); payload.encrypted = 1; }
  ws.send(JSON.stringify(payload));
  appendTextBubble({name:state.name, text: state.e2e ? "[You: Encrypted]" : text, ts, self:true, id});
  messageInput.value=""; messageInput.focus();
}
$("#send").addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e)=>{ if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendMessage(); } });
messageInput.addEventListener("input", ()=>{ if (ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:"typing"})); });

$("#file").addEventListener("change", async (e)=>{
  const f = e.target.files[0]; if (!f || !ws || ws.readyState!==WebSocket.OPEN) return;
  if (f.size > 2*1024*1024){ alert("Max 2 MB for demo."); return; }
  const reader = new FileReader();
  reader.onload = ()=>{
    const id = crypto.randomUUID(); const ts = tsNow();
    const payload = { type:"file", filename:f.name, data: reader.result, ts, encrypted:0, messageId:id };
    ws.send(JSON.stringify(payload));
    appendFileBubble({name:state.name, data:reader.result, filename:f.name, ts, self:true, id});
    $("#file").value="";
  };
  reader.readAsDataURL(f);
});

$("#theme-toggle").addEventListener("click", ()=> document.body.classList.toggle("light"));
$("#copy-link").addEventListener("click", async ()=>{
  const url = new URL(location.href); url.search=""; url.hash="";
  const invite = `${url.origin}/?room=${encodeURIComponent($("#room").value || state.room)}`;
  await navigator.clipboard.writeText(invite); alert("Invite copied. Share password separately.");
});

window.addEventListener("DOMContentLoaded", ()=>{
  const params = new URLSearchParams(location.search);
  const room = params.get("room"); if (room) $("#room").value = room;
});