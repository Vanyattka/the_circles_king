export type ClientMessage =
  | { type: "join"; roomCode: string; nickname: string }
  | { type: "input"; seq: number; input: PlayerInput };

export type ServerMessage =
  | {
      type: "welcome";
      playerId: string;
      roomCode: string;
      snapshotRate: number;
      tickRate: number;
      world: WorldConfig;
    }
  | {
      type: "snapshot";
      tick: number;
      players: PlayerSnapshot[];
      circle: SafeCircleSnapshot;
      event?: ActiveEvent;
      remainingMs: number;
    }
  | { type: "event"; event: ActiveEvent }
  | { type: "death"; playerId: string; nickname: string }
  | { type: "roundEnd"; winnerId: string | null; reason: "lastAlive" | "timeout" }
  | { type: "error"; message: string };

export type PlayerInput = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  dash: boolean;
};

export type PlayerSnapshot = {
  id: string;
  x: number;
  y: number;
  radius: number;
  nickname: string;
  hp: number;
  alive: boolean;
  dominationTime: number;
};

export type SafeCircleSnapshot = {
  x: number;
  y: number;
  radius: number;
  innerRadius: number;
};

export type WorldConfig = {
  width: number;
  height: number;
};

export type ActiveEvent =
  | { type: "SHIFT"; targetX: number; targetY: number; durationMs: number }
  | { type: "PULSE"; durationMs: number; amplitude: number }
  | { type: "RESIZE"; targetRadius: number }
  | { type: "ACCEL"; speedBoost: number; accelBoost: number };
};
