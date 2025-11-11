const canvas = document.getElementById("stars");
const ctx = canvas.getContext("2d");
let stars = [];
function resize(){
  canvas.width = innerWidth; canvas.height = innerHeight;
  stars = Array.from({length: Math.min(300, Math.floor((innerWidth*innerHeight)/8000))}, () => ({
    x: Math.random()*canvas.width,
    y: Math.random()*canvas.height,
    z: Math.random()*1.5 + 0.5,
    r: Math.random()*1.2 + 0.2
  }));
}
window.addEventListener("resize", resize); resize();
function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  for(const s of stars){
    ctx.fillStyle = `rgba(180,200,255,${0.4 + Math.random()*0.6})`;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2); ctx.fill();
    s.x += 0.02*s.z; if (s.x > canvas.width+2) s.x = -2;
  }
  requestAnimationFrame(draw);
}
draw();