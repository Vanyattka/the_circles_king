import type {
  ClientMessage,
  PlayerInput,
  ServerMessage,
  SafeCircleSnapshot,
  WorldConfig,
  ActiveEvent
} from "@tck/shared/src/protocol";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
const lobby = document.querySelector<HTMLDivElement>("#lobby");
const roomInput = document.querySelector<HTMLInputElement>("#room");
const nicknameInput = document.querySelector<HTMLInputElement>("#nickname");
const joinButton = document.querySelector<HTMLButtonElement>("#join");
const statusLabel = document.querySelector<HTMLDivElement>("#status");
const hud = document.querySelector<HTMLDivElement>("#hud");

if (!canvas || !lobby || !roomInput || !nicknameInput || !joinButton || !statusLabel || !hud) {
  throw new Error("Missing UI elements");
}

const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("Canvas not supported");
}

const state = {
  socket: null as WebSocket | null,
  playerId: "",
  connected: false,
  world: { width: 1200, height: 800 } as WorldConfig,
  lastEvent: null as ActiveEvent | null,
  roundEnd: null as Extract<ServerMessage, { type: "roundEnd" }> | null,
  winnerName: "",
  deathBanner: null as { text: string; start: number } | null,
  eventBursts: [] as Array<{ type: string; start: number }>,
  fireworks: [] as Array<{ x: number; y: number; start: number; color: string }>,
  dialogs: [] as Array<{ id: string; text: string; x: number; y: number; start: number }>,
  lastCollisions: new Map<string, number>(),
  input: {
    up: false,
    down: false,
    left: false,
    right: false,
    dash: false
  } as PlayerInput,
  seq: 0,
  snapshots: [] as Array<{ time: number; snapshot: Extract<ServerMessage, { type: "snapshot" }> }>
};

const INTERP_DELAY = 120;
const DIALOG_DURATION = 1400;
const COLLISION_COOLDOWN = 900;
const DEATH_DURATION = 2200;
const FIREWORK_DURATION = 1800;
const eventPalette = ["#f7ff5b", "#ff8c2a", "#5bffbd", "#ff5bbd"];
const dialogLines = [
  "Ты че, баран?",
  "Куда лезешь!",
  "Это мой круг!",
  "Отойди, шлеп!",
  "Задирайся в другом месте",
  "Я тут главный!",
  "Шатайся вон туда",
  "Ой, прости, не туда"
];

const backgroundProps = Array.from({ length: 28 }, () => ({
  x: Math.random() * 1200,
  y: Math.random() * 800,
  size: 20 + Math.random() * 38,
  type: Math.floor(Math.random() * 4),
  rot: Math.random() * Math.PI * 2,
  color: eventPalette[Math.floor(Math.random() * eventPalette.length)]
}));

const resize = () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
};
window.addEventListener("resize", resize);
resize();

const updateStatus = (text: string) => {
  statusLabel.textContent = text;
};

const sendMessage = (message: ClientMessage) => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  state.socket.send(JSON.stringify(message));
};

const colorForId = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 78%, 60%)`;
};

const addDialog = (playerId: string, x: number, y: number) => {
  const text = dialogLines[Math.floor(Math.random() * dialogLines.length)];
  state.dialogs.push({ id: playerId + Date.now().toString(36), text, x, y, start: performance.now() });
  if (state.dialogs.length > 12) {
    state.dialogs.shift();
  }
};

const emitCollisionDialogs = (players: Array<{ id: string; x: number; y: number; radius: number }>) => {
  const now = performance.now();
  for (let i = 0; i < players.length; i += 1) {
    const a = players[i];
    for (let j = i + 1; j < players.length; j += 1) {
      const b = players[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist > a.radius + b.radius + 2) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const last = state.lastCollisions.get(key) ?? 0;
      if (now - last < COLLISION_COOLDOWN) continue;
      state.lastCollisions.set(key, now);
      addDialog(a.id, a.x, a.y);
      addDialog(b.id, b.x, b.y);
    }
  }
};

const drawRoundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const spawnFireworks = () => {
  const bursts = [];
  const count = 8;
  for (let i = 0; i < count; i += 1) {
    bursts.push({
      x: canvas.width * 0.2 + Math.random() * canvas.width * 0.6,
      y: 80 + Math.random() * 180,
      start: performance.now() + i * 120,
      color: eventPalette[i % eventPalette.length]
    });
  }
  state.fireworks = bursts;
};

const connect = () => {
  const roomCode = roomInput.value.trim();
  const nickname = nicknameInput.value.trim();
  if (!roomCode || !nickname) {
    updateStatus("Room code and nickname required.");
    return;
  }

  joinButton.disabled = true;
  updateStatus("Connecting...");

  const host = window.location.hostname;
  const socket = new WebSocket(`ws://${host}:8080`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    sendMessage({ type: "join", roomCode, nickname });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as ServerMessage;
    if (message.type === "welcome") {
      state.playerId = message.playerId;
      state.connected = true;
      state.world = message.world;
      state.snapshots = [];
      state.lastEvent = null;
      state.roundEnd = null;
      state.winnerName = "";
      state.deathBanner = null;
      state.fireworks = [];
      lobby.style.display = "none";
      updateStatus(`Joined ${message.roomCode}`);
      return;
    }
    if (message.type === "snapshot") {
      state.snapshots.push({ time: performance.now(), snapshot: message });
      if (state.snapshots.length > 5) {
        state.snapshots.shift();
      }
      return;
    }
    if (message.type === "event") {
      state.lastEvent = message.event;
      state.eventBursts.push({ type: message.event.type, start: performance.now() });
      if (state.eventBursts.length > 6) state.eventBursts.shift();
      return;
    }
    if (message.type === "death") {
      state.deathBanner = {
        text: `${message.nickname} ПОМЕР`,
        start: performance.now()
      };
      return;
    }
    if (message.type === "roundEnd") {
      state.roundEnd = message;
      if (message.reason === "lastAlive") {
        const latest = state.snapshots[state.snapshots.length - 1]?.snapshot;
        const winner = latest?.players.find((player) => player.id === message.winnerId);
        state.winnerName = winner?.nickname ?? message.winnerId ?? "";
        spawnFireworks();
      }
      return;
    }
    if (message.type === "error") {
      updateStatus(message.message);
      joinButton.disabled = false;
    }
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    lobby.style.display = "grid";
    joinButton.disabled = false;
    updateStatus("Disconnected.");
  });
};

joinButton.addEventListener("click", connect);

window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (event.code === "KeyW") state.input.up = true;
  if (event.code === "KeyS") state.input.down = true;
  if (event.code === "KeyA") state.input.left = true;
  if (event.code === "KeyD") state.input.right = true;
  if (event.code === "ArrowUp") state.input.up = true;
  if (event.code === "ArrowDown") state.input.down = true;
  if (event.code === "ArrowLeft") state.input.left = true;
  if (event.code === "ArrowRight") state.input.right = true;
  if (event.code === "Space") state.input.dash = true;
});

window.addEventListener("keyup", (event) => {
  if (event.code === "KeyW") state.input.up = false;
  if (event.code === "KeyS") state.input.down = false;
  if (event.code === "KeyA") state.input.left = false;
  if (event.code === "KeyD") state.input.right = false;
  if (event.code === "ArrowUp") state.input.up = false;
  if (event.code === "ArrowDown") state.input.down = false;
  if (event.code === "ArrowLeft") state.input.left = false;
  if (event.code === "ArrowRight") state.input.right = false;
  if (event.code === "Space") state.input.dash = false;
});

setInterval(() => {
  if (!state.connected) return;
  const message: ClientMessage = {
    type: "input",
    seq: state.seq++,
    input: { ...state.input }
  };
  sendMessage(message);
  state.input.dash = false;
}, 50);

const render = () => {
  requestAnimationFrame(render);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!state.connected) {
    hud.textContent = "";
    return;
  }

  const now = performance.now();
  const renderTime = now - INTERP_DELAY;
  const snapshots = state.snapshots;

  if (snapshots.length === 0) {
    return;
  }

  let baseIndex = snapshots.findIndex((snap) => snap.time > renderTime) - 1;
  if (baseIndex < 0) baseIndex = snapshots.length - 1;

  const from = snapshots[Math.max(0, baseIndex)];
  const to = snapshots[Math.min(snapshots.length - 1, baseIndex + 1)];
  const span = Math.max(1, to.time - from.time);
  const t = Math.min(1, Math.max(0, (renderTime - from.time) / span));

  const players = from.snapshot.players.map((player) => {
    const target = to.snapshot.players.find((p) => p.id === player.id);
    if (!target) return player;
    return {
      ...player,
      x: player.x + (target.x - player.x) * t,
      y: player.y + (target.y - player.y) * t
    };
  });

  const circleFrom = from.snapshot.circle;
  const circleTo = to.snapshot.circle;
  const circle: SafeCircleSnapshot = {
    x: circleFrom.x + (circleTo.x - circleFrom.x) * t,
    y: circleFrom.y + (circleTo.y - circleFrom.y) * t,
    radius: circleFrom.radius + (circleTo.radius - circleFrom.radius) * t,
    innerRadius: circleFrom.innerRadius + (circleTo.innerRadius - circleFrom.innerRadius) * t
  };

  const me = players.find((player) => player.id === state.playerId);
  const focusX = me?.x ?? state.world.width * 0.5;
  const focusY = me?.y ?? state.world.height * 0.5;
  const offsetX = canvas.width * 0.5 - focusX;
  const offsetY = canvas.height * 0.5 - focusY;

  ctx.fillStyle = "#0b1118";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(offsetX, offsetY);

  for (const prop of backgroundProps) {
    ctx.save();
    ctx.translate(prop.x, prop.y);
    ctx.rotate(prop.rot);
    ctx.fillStyle = prop.color;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    if (prop.type === 0) {
      ctx.beginPath();
      ctx.ellipse(0, 0, prop.size * 0.7, prop.size * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(prop.size * 0.2, -prop.size * 0.1, prop.size * 0.18, 0, Math.PI * 2);
      ctx.fill();
    } else if (prop.type === 1) {
      ctx.beginPath();
      ctx.moveTo(-prop.size * 0.4, prop.size * 0.5);
      ctx.lineTo(0, -prop.size * 0.6);
      ctx.lineTo(prop.size * 0.4, prop.size * 0.5);
      ctx.closePath();
      ctx.fill();
    } else if (prop.type === 2) {
      ctx.beginPath();
      ctx.arc(0, 0, prop.size * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(10, 12, 20, 0.85)";
      ctx.beginPath();
      ctx.arc(0, 0, prop.size * 0.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.rect(-prop.size * 0.4, -prop.size * 0.2, prop.size * 0.8, prop.size * 0.4);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-prop.size * 0.1, -prop.size * 0.3);
      ctx.lineTo(prop.size * 0.3, -prop.size * 0.1);
      ctx.lineTo(-prop.size * 0.2, prop.size * 0.2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.strokeStyle = "rgba(90, 200, 255, 0.45)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(90, 200, 255, 0.2)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(circle.x, circle.y, circle.innerRadius, 0, Math.PI * 2);
  ctx.stroke();

  for (const player of players) {
    const isLocal = player.id === state.playerId;
    const baseColor = colorForId(player.id);
    if (player.alive) {
      ctx.beginPath();
      ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
      ctx.fillStyle = isLocal ? "#35b1ff" : baseColor;
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(player.x, player.y - player.radius);
      ctx.lineTo(player.x - player.radius, player.y + player.radius);
      ctx.lineTo(player.x + player.radius, player.y + player.radius);
      ctx.closePath();
      ctx.fillStyle = "rgba(30, 30, 30, 0.9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 80, 80, 0.7)";
      ctx.stroke();
    }

    ctx.fillStyle = "#e5f1ff";
    ctx.font = "12px Trebuchet MS";
    ctx.textAlign = "center";
    ctx.fillText(player.nickname, player.x, player.y - player.radius - 6);
  }

  emitCollisionDialogs(players);

  state.dialogs = state.dialogs.filter((dialog) => now - dialog.start < DIALOG_DURATION);
  for (const dialog of state.dialogs) {
    const life = Math.min(1, (now - dialog.start) / DIALOG_DURATION);
    const floatY = -18 - life * 22;
    const scale = 1 + Math.sin(life * Math.PI) * 0.18;
    ctx.save();
    ctx.translate(dialog.x, dialog.y + floatY);
    ctx.scale(scale, scale);
    ctx.fillStyle = "rgba(20, 24, 35, 0.92)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    drawRoundRect(ctx, -60, -24, 120, 30, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f7ff5b";
    ctx.font = "12px Trebuchet MS";
    ctx.textAlign = "center";
    ctx.fillText(dialog.text, 0, -5);
    ctx.restore();
  }

  ctx.restore();

  const remaining = Math.max(0, Math.round(from.snapshot.remainingMs / 1000));
  const eventLabel = state.lastEvent ? `Event: ${state.lastEvent.type}` : "";
  const roundLabel = state.roundEnd
    ? `Winner: ${state.roundEnd.winnerId ?? "none"} (${state.roundEnd.reason})`
    : "";
  hud.textContent = `Players: ${players.length}  HP: ${me?.hp ?? 0}  Domination: ${Math.floor(
    me?.dominationTime ?? 0
  )}s  Time: ${remaining}s  ${eventLabel}  ${roundLabel}`;

  for (const burst of state.eventBursts) {
    const progress = (now - burst.start) / 1200;
    if (progress >= 1) continue;
    const x = canvas.width - 120;
    const y = 90;
    const radius = 12 + progress * 40;
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    ctx.strokeStyle = eventPalette[Math.floor(Math.random() * eventPalette.length)];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8;
      const r1 = radius * 0.5;
      const r2 = radius * 1.1;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * r1, y + Math.sin(angle) * r1);
      ctx.lineTo(x + Math.cos(angle) * r2, y + Math.sin(angle) * r2);
      ctx.stroke();
    }
    ctx.fillStyle = "#f7ff5b";
    ctx.font = "14px Trebuchet MS";
    ctx.textAlign = "center";
    ctx.fillText(burst.type, x, y + 6);
    ctx.restore();
  }

  if (state.deathBanner) {
    const life = (now - state.deathBanner.start) / DEATH_DURATION;
    if (life < 1) {
      const scale = 1 + Math.sin(life * Math.PI) * 0.12;
      ctx.save();
      ctx.translate(canvas.width * 0.5, canvas.height * 0.2);
      ctx.scale(scale, scale);
      ctx.font = "48px Trebuchet MS";
      ctx.textAlign = "center";
      ctx.fillStyle = "#ff1b1b";
      ctx.strokeStyle = "#120607";
      ctx.lineWidth = 8;
      ctx.strokeText(state.deathBanner.text, 0, 0);
      ctx.fillText(state.deathBanner.text, 0, 0);
      ctx.restore();
    } else {
      state.deathBanner = null;
    }
  }

  if (state.fireworks.length > 0) {
    for (const burst of state.fireworks) {
      const life = (now - burst.start) / FIREWORK_DURATION;
      if (life < 0 || life > 1) continue;
      const radius = 10 + life * 70;
      ctx.save();
      ctx.globalAlpha = 1 - life;
      ctx.strokeStyle = burst.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(burst.x, burst.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 12; i += 1) {
        const angle = (Math.PI * 2 * i) / 12;
        const r1 = radius * 0.4;
        const r2 = radius * 1.2;
        ctx.beginPath();
        ctx.moveTo(burst.x + Math.cos(angle) * r1, burst.y + Math.sin(angle) * r1);
        ctx.lineTo(burst.x + Math.cos(angle) * r2, burst.y + Math.sin(angle) * r2);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (state.winnerName) {
      ctx.save();
      ctx.font = "30px Trebuchet MS";
      ctx.textAlign = "center";
      ctx.fillStyle = "#f7ff5b";
      ctx.strokeStyle = "#0b0f14";
      ctx.lineWidth = 6;
      ctx.strokeText(`Победил: ${state.winnerName}`, canvas.width * 0.5, 60);
      ctx.fillText(`Победил: ${state.winnerName}`, canvas.width * 0.5, 60);
      ctx.restore();
    }
  }
};

render();
