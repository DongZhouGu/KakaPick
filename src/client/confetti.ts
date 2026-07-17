// Lightweight confetti celebration for milestone moments
export function confetti(count = 80): void {
  const colors = ["#c8963e", "#ffd60a", "#30d158", "#ff453a", "#0a84ff", "#bf5af2", "#ff9f0a", "#5e5ce6"];
  for (let i = 0; i < count; i++) {
    const particle = document.createElement("span");
    particle.style.cssText = `position:fixed;z-index:9999;top:${Math.random() * 30}%;left:${Math.random() * 100}%;width:${6 + Math.random() * 8}px;height:${6 + Math.random() * 12}px;border-radius:${Math.random() > 0.5 ? "50%" : "2px"};background:${colors[Math.floor(Math.random() * colors.length)]};pointer-events:none;animation:confettiFall ${1.5 + Math.random() * 2}s ease-out forwards;animation-delay:${Math.random() * 0.5}s;`;
    document.body.appendChild(particle);
    setTimeout(() => particle.remove(), 3000);
  }
}

// Inject keyframes once
if (typeof document !== "undefined" && !document.getElementById("confetti-style")) {
  const style = document.createElement("style");
  style.id = "confetti-style";
  style.textContent = `@keyframes confettiFall{0%{transform:translateY(0) rotate(0deg) scale(1);opacity:1}100%{transform:translateY(100vh) rotate(${360 + Math.random() * 720}deg) scale(0);opacity:0}}`;
  document.head.appendChild(style);
}
