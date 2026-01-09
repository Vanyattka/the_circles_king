import { WebSocketServer, WebSocket } from "ws";
import type {
  ActiveEvent,
  ClientMessage,
  PlayerInput,
  SafeCircleSnapshot,
  ServerMessage,
  WorldConfig
} from "@tck/shared/src/protocol";

type Player = {
  id: string;
  nickname: string;
  ws: WebSocket;
  input: PlayerInput;
  x: number;
  y: number;
  vx: number;
  vy: number;
  lastDir: { x: number; y: number };
  dashCooldown: number;
  hp: number;
  alive: boolean;
  dominationTime: number;
};

type CircleState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  driftSpeed: number;
  driftAccel: number;
  driftTimer: number;
  baseRadius: number;
  minRadius: number;
  maxRadius: number;
  shrinkRate: number;
  innerFactor: number;
  shift: {
    active: boolean;
    startX: number;
    startY: number;
    targetX: number;
    targetY: number;
    duration: number;
    elapsed: number;
  };
  pulse: {
    active: boolean;
    duration: number;
    elapsed: number;
    amplitude: number;
  };
};

type Room = {
  code: string;
  players: Map<string, Player>;
  tick: number;
  elapsedMs: number;
  nextShiftMs: number;
  nextPulseMs: number;
  nextResizeMs: number;
  nextAccelMs: number;
  circle: CircleState;
  roundEnded: boolean;
};

const PORT = 8080;
const TICK_RATE = 30;
const SNAPSHOT_RATE = 12;
const WORLD: WorldConfig = { width: 1200, height: 800 };

const PLAYER_RADIUS = 18;
const MAX_SPEED = 520;
const ACCEL = 1400;
const DAMPING = 3.2;
const DASH_SPEED = 720;
const DASH_COOLDOWN = 3;
const COLLISION_PUSH = 520;
const OUTSIDE_SPEED_MULT = 0.6;
const OUTSIDE_HP_DRAIN = 12;

const ROUND_DURATION_MS = 180000;
const SHIFT_INTERVAL_MS = 15000;
const SHIFT_DURATION_MS = 2000;
const PULSE_INTERVAL_MS = 18000;
const PULSE_DURATION_MS = 6000;
const PULSE_AMPLITUDE = 0.12;
const PULSE_FREQ = 5;
const RESIZE_INTERVAL_MS = 22000;
const ACCEL_INTERVAL_MS = 20000;

const rooms = new Map<string, Room>();

const wss = new WebSocketServer({ port: PORT });

const createRoom = (code: string): Room => ({
  code,
  players: new Map(),
  tick: 0,
  elapsedMs: 0,
  nextShiftMs: SHIFT_INTERVAL_MS,
  nextPulseMs: PULSE_INTERVAL_MS,
  nextResizeMs: RESIZE_INTERVAL_MS,
  nextAccelMs: ACCEL_INTERVAL_MS,
  circle: {
    x: WORLD.width * 0.5,
    y: WORLD.height * 0.5,
    vx: 1,
    vy: 0,
    driftSpeed: 8,
    driftAccel: 1.2,
    driftTimer: 2,
    baseRadius: 320,
    minRadius: 140,
    maxRadius: 420,
    shrinkRate: 0.7,
    innerFactor: 0.6,
    shift: {
      active: false,
      startX: WORLD.width * 0.5,
      startY: WORLD.height * 0.5,
      targetX: WORLD.width * 0.5,
      targetY: WORLD.height * 0.5,
      duration: SHIFT_DURATION_MS / 1000,
      elapsed: 0
    },
    pulse: {
      active: false,
      duration: PULSE_DURATION_MS / 1000,
      elapsed: 0,
      amplitude: PULSE_AMPLITUDE
    }
  },
  roundEnded: false
});

const resetRoomRound = (room: Room) => {
  room.elapsedMs = 0;
  room.nextShiftMs = SHIFT_INTERVAL_MS;
  room.nextPulseMs = PULSE_INTERVAL_MS;
  room.nextResizeMs = RESIZE_INTERVAL_MS;
  room.nextAccelMs = ACCEL_INTERVAL_MS;
  room.roundEnded = false;
  room.circle = {
    x: WORLD.width * 0.5,
    y: WORLD.height * 0.5,
    vx: 1,
    vy: 0,
    driftSpeed: 8,
    driftAccel: 1.2,
    driftTimer: 2,
    baseRadius: 320,
    minRadius: 140,
    maxRadius: 420,
    shrinkRate: 0.7,
    innerFactor: 0.6,
    shift: {
      active: false,
      startX: WORLD.width * 0.5,
      startY: WORLD.height * 0.5,
      targetX: WORLD.width * 0.5,
      targetY: WORLD.height * 0.5,
      duration: SHIFT_DURATION_MS / 1000,
      elapsed: 0
    },
    pulse: {
      active: false,
      duration: PULSE_DURATION_MS / 1000,
      elapsed: 0,
      amplitude: PULSE_AMPLITUDE
    }
  };

  for (const player of room.players.values()) {
    player.hp = 100;
    player.alive = true;
    player.dominationTime = 0;
    player.vx = 0;
    player.vy = 0;
  }
};

const randomId = () => Math.random().toString(36).slice(2, 9);

const safeSend = (ws: WebSocket, message: ServerMessage) => {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
};

const normalize = (x: number, y: number) => {
  const len = Math.hypot(x, y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
};

const clampMagnitude = (vx: number, vy: number, max: number) => {
  const len = Math.hypot(vx, vy);
  if (len <= max) return { vx, vy };
  const scale = max / len;
  return { vx: vx * scale, vy: vy * scale };
};

const getCircleSnapshot = (circle: CircleState): SafeCircleSnapshot => {
  const pulse = circle.pulse.active
    ? 1 + circle.pulse.amplitude * Math.sin(circle.pulse.elapsed * PULSE_FREQ)
    : 1;
  const radius = circle.baseRadius * pulse;
  return {
    x: circle.x,
    y: circle.y,
    radius,
    innerRadius: radius * circle.innerFactor
  };
};

const isOutside = (player: Player, circle: SafeCircleSnapshot) => {
  const dist = Math.hypot(player.x - circle.x, player.y - circle.y);
  return dist > circle.radius;
};

const applyInput = (player: Player, dt: number, speedMultiplier: number) => {
  if (!player.alive) return;

  const input = player.input;
  const dirX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const dirY = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const dir = normalize(dirX, dirY);

  if (dir.x !== 0 || dir.y !== 0) {
    player.lastDir = dir;
  }

  player.vx += dir.x * ACCEL * speedMultiplier * dt;
  player.vy += dir.y * ACCEL * speedMultiplier * dt;

  if (input.dash && player.dashCooldown <= 0) {
    player.vx += player.lastDir.x * DASH_SPEED;
    player.vy += player.lastDir.y * DASH_SPEED;
    player.dashCooldown = DASH_COOLDOWN;
  }

  const damping = Math.exp(-DAMPING * dt);
  player.vx *= damping;
  player.vy *= damping;

  const clamped = clampMagnitude(player.vx, player.vy, MAX_SPEED);
  player.vx = clamped.vx;
  player.vy = clamped.vy;

  player.x += player.vx * dt;
  player.y += player.vy * dt;

  player.x = Math.max(PLAYER_RADIUS, Math.min(WORLD.width - PLAYER_RADIUS, player.x));
  player.y = Math.max(PLAYER_RADIUS, Math.min(WORLD.height - PLAYER_RADIUS, player.y));
};

const resolveCollisions = (players: Player[]) => {
  for (let i = 0; i < players.length; i += 1) {
    const a = players[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < players.length; j += 1) {
      const b = players[j];
      if (!b.alive) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = PLAYER_RADIUS * 2;
      if (dist === 0 || dist >= minDist) continue;

      const overlap = minDist - dist;
      const nx = dx / dist;
      const ny = dy / dist;

      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;

      a.vx -= nx * COLLISION_PUSH;
      a.vy -= ny * COLLISION_PUSH;
      b.vx += nx * COLLISION_PUSH;
      b.vy += ny * COLLISION_PUSH;
    }
  }
};

const updateCircle = (room: Room, dt: number) => {
  const circle = room.circle;
  circle.driftTimer -= dt;
  if (circle.driftTimer <= 0) {
    const angle = Math.random() * Math.PI * 2;
    circle.vx = Math.cos(angle);
    circle.vy = Math.sin(angle);
    circle.driftTimer = 2 + Math.random() * 2;
  }
  circle.driftSpeed += circle.driftAccel * dt;
  circle.x += circle.vx * circle.driftSpeed * dt;
  circle.y += circle.vy * circle.driftSpeed * dt;

  const margin = circle.baseRadius + 20;
  if (circle.x < margin || circle.x > WORLD.width - margin) {
    circle.vx *= -1;
    circle.x = Math.max(margin, Math.min(WORLD.width - margin, circle.x));
  }
  if (circle.y < margin || circle.y > WORLD.height - margin) {
    circle.vy *= -1;
    circle.y = Math.max(margin, Math.min(WORLD.height - margin, circle.y));
  }

  circle.baseRadius = Math.max(circle.minRadius, circle.baseRadius - circle.shrinkRate * dt);

  if (circle.shift.active) {
    circle.shift.elapsed += dt;
    const t = Math.min(1, circle.shift.elapsed / circle.shift.duration);
    circle.x = circle.shift.startX + (circle.shift.targetX - circle.shift.startX) * t;
    circle.y = circle.shift.startY + (circle.shift.targetY - circle.shift.startY) * t;
    if (t >= 1) {
      circle.shift.active = false;
    }
  }

  if (circle.pulse.active) {
    circle.pulse.elapsed += dt;
    if (circle.pulse.elapsed >= circle.pulse.duration) {
      circle.pulse.active = false;
      circle.pulse.elapsed = 0;
    }
  }
};

const triggerShift = (room: Room): ActiveEvent => {
  const margin = Math.max(140, room.circle.baseRadius * 0.6);
  const targetX = margin + Math.random() * (WORLD.width - margin * 2);
  const targetY = margin + Math.random() * (WORLD.height - margin * 2);

  room.circle.shift = {
    active: true,
    startX: room.circle.x,
    startY: room.circle.y,
    targetX,
    targetY,
    duration: SHIFT_DURATION_MS / 1000,
    elapsed: 0
  };

  return { type: "SHIFT", targetX, targetY, durationMs: SHIFT_DURATION_MS };
};

const triggerResize = (room: Room): ActiveEvent => {
  const targetRadius =
    room.circle.minRadius +
    Math.random() * (room.circle.maxRadius - room.circle.minRadius);
  room.circle.baseRadius = targetRadius;
  return { type: "RESIZE", targetRadius };
};

const triggerAccel = (room: Room): ActiveEvent => {
  const speedBoost = 10;
  const accelBoost = 0.6;
  room.circle.driftSpeed += speedBoost;
  room.circle.driftAccel += accelBoost;
  return { type: "ACCEL", speedBoost, accelBoost };
};

const triggerPulse = (room: Room): ActiveEvent => {
  room.circle.pulse = {
    active: true,
    duration: PULSE_DURATION_MS / 1000,
    elapsed: 0,
    amplitude: PULSE_AMPLITUDE
  };

  return { type: "PULSE", durationMs: PULSE_DURATION_MS, amplitude: PULSE_AMPLITUDE };
};

const updateRoom = (room: Room, dt: number) => {
  if (room.roundEnded) {
    room.tick += 1;
    return;
  }

  room.elapsedMs += dt * 1000;
  room.tick += 1;

  updateCircle(room, dt);

  const currentCircle = getCircleSnapshot(room.circle);

  for (const player of room.players.values()) {
    player.dashCooldown = Math.max(0, player.dashCooldown - dt);
    const outside = isOutside(player, currentCircle);
    const speedMultiplier = outside ? OUTSIDE_SPEED_MULT : 1;
    applyInput(player, dt, speedMultiplier);
  }

  resolveCollisions(Array.from(room.players.values()));

  const circleSnapshot = getCircleSnapshot(room.circle);

  for (const player of room.players.values()) {
    if (!player.alive) continue;
    const outsideNow = isOutside(player, circleSnapshot);
    if (outsideNow) {
      player.hp = Math.max(0, player.hp - OUTSIDE_HP_DRAIN * dt);
    }
    if (player.hp <= 0) {
      player.alive = false;
      player.vx = 0;
      player.vy = 0;
      broadcastDeath(room, player);
      continue;
    }
    const dist = Math.hypot(player.x - circleSnapshot.x, player.y - circleSnapshot.y);
    if (dist <= circleSnapshot.innerRadius) {
      player.dominationTime += dt;
    }
  }

  if (room.elapsedMs >= room.nextShiftMs) {
    room.nextShiftMs += SHIFT_INTERVAL_MS;
    const event = triggerShift(room);
    broadcastEvent(room, event);
  }

  if (room.elapsedMs >= room.nextPulseMs) {
    room.nextPulseMs += PULSE_INTERVAL_MS;
    const event = triggerPulse(room);
    broadcastEvent(room, event);
  }

  if (room.elapsedMs >= room.nextResizeMs) {
    room.nextResizeMs += RESIZE_INTERVAL_MS;
    const event = triggerResize(room);
    broadcastEvent(room, event);
  }

  if (room.elapsedMs >= room.nextAccelMs) {
    room.nextAccelMs += ACCEL_INTERVAL_MS;
    const event = triggerAccel(room);
    broadcastEvent(room, event);
  }

  checkRoundEnd(room);
};

const broadcastEvent = (room: Room, event: ActiveEvent) => {
  const message: ServerMessage = { type: "event", event };
  for (const player of room.players.values()) {
    safeSend(player.ws, message);
  }
};

const broadcastDeath = (room: Room, player: Player) => {
  const message: ServerMessage = { type: "death", playerId: player.id, nickname: player.nickname };
  for (const member of room.players.values()) {
    safeSend(member.ws, message);
  }
};

const checkRoundEnd = (room: Room) => {
  if (room.roundEnded) return;
  if (room.players.size < 2) return;
  const alivePlayers = Array.from(room.players.values()).filter((player) => player.alive);
  if (alivePlayers.length <= 1) {
    room.roundEnded = true;
    const winnerId = alivePlayers[0]?.id ?? null;
    const message: ServerMessage = { type: "roundEnd", winnerId, reason: "lastAlive" };
    for (const player of room.players.values()) {
      safeSend(player.ws, message);
    }
    return;
  }

  if (room.elapsedMs >= ROUND_DURATION_MS) {
    room.roundEnded = true;
    let winnerId: string | null = null;
    let bestDomination = -1;
    for (const player of room.players.values()) {
      if (player.dominationTime > bestDomination) {
        bestDomination = player.dominationTime;
        winnerId = player.id;
      }
    }
    const message: ServerMessage = { type: "roundEnd", winnerId, reason: "timeout" };
    for (const player of room.players.values()) {
      safeSend(player.ws, message);
    }
  }
};

const broadcastSnapshots = () => {
  for (const room of rooms.values()) {
    const circleSnapshot = getCircleSnapshot(room.circle);
    const snapshot: ServerMessage = {
      type: "snapshot",
      tick: room.tick,
      players: Array.from(room.players.values()).map((player) => ({
        id: player.id,
        x: player.x,
        y: player.y,
        radius: PLAYER_RADIUS,
        nickname: player.nickname,
        hp: player.hp,
        alive: player.alive,
        dominationTime: player.dominationTime
      })),
      circle: circleSnapshot,
      remainingMs: Math.max(0, ROUND_DURATION_MS - room.elapsedMs)
    };

    for (const player of room.players.values()) {
      safeSend(player.ws, snapshot);
    }
  }
};

wss.on("connection", (ws) => {
  let currentRoom: Room | null = null;
  let playerId: string | null = null;

  ws.on("message", (data) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      safeSend(ws, { type: "error", message: "Invalid message." });
      return;
    }

    if (message.type === "join") {
      if (currentRoom) {
        safeSend(ws, { type: "error", message: "Already joined." });
        return;
      }

      const roomCode = message.roomCode.trim().toUpperCase();
      const nickname = message.nickname.trim().slice(0, 16) || "Player";
      const room = rooms.get(roomCode) ?? createRoom(roomCode);
      rooms.set(roomCode, room);

      playerId = randomId();
      const player: Player = {
        id: playerId,
        nickname,
        ws,
        input: { up: false, down: false, left: false, right: false, dash: false },
        x: room.circle.x + (Math.random() - 0.5) * 120,
        y: room.circle.y + (Math.random() - 0.5) * 120,
        vx: 0,
        vy: 0,
        lastDir: { x: 0, y: -1 },
        dashCooldown: 0,
        hp: 100,
        alive: true,
        dominationTime: 0
      };

      room.players.set(playerId, player);
      currentRoom = room;

      if (room.roundEnded) {
        resetRoomRound(room);
      }

      safeSend(ws, {
        type: "welcome",
        playerId,
        roomCode,
        snapshotRate: SNAPSHOT_RATE,
        tickRate: TICK_RATE,
        world: WORLD
      });
      return;
    }

    if (message.type === "input") {
      if (!currentRoom || !playerId) {
        safeSend(ws, { type: "error", message: "Join a room first." });
        return;
      }
      const player = currentRoom.players.get(playerId);
      if (!player || !player.alive) return;
      player.input = message.input;
      return;
    }
  });

  ws.on("close", () => {
    if (!currentRoom || !playerId) return;
    currentRoom.players.delete(playerId);
    if (currentRoom.players.size === 0) {
      rooms.delete(currentRoom.code);
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    updateRoom(room, 1 / TICK_RATE);
  }
}, 1000 / TICK_RATE);

setInterval(broadcastSnapshots, 1000 / SNAPSHOT_RATE);

console.log(`Server listening on ws://localhost:${PORT}`);
