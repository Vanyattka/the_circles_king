# King of the Circle (MVP)

Fast-paced online multiplayer arena game for 2-10 players.

## Core loop

- Stay inside the moving safe circle
- Push other players out via collisions
- Survive and/or score domination time

## MVP goals

- Real-time multiplayer (WebSocket), 2-10 players per room
- Top-down 2D arena with physics-lite movement (inertia + push on collision)
- Dynamic safe circle:
  - shrink over time
  - periodic shift
  - outside circle = debuff + HP drain -> elimination
- Periodic events (at least 2):
  - SHIFT
  - PULSE
- Simple lobby:
  - create / join room
  - nickname
  - ready
  - start
- Scoreboard:
  - last alive OR
  - highest domination time at timeout

## Tech stack

- Client: TypeScript + Vite + Canvas 2D
- Server: Node.js + TypeScript + ws (WebSocket)
- Shared: protocol types + simulation helpers
- Monorepo: npm workspaces
  - `packages/client`
  - `packages/server`
  - `packages/shared`

## Quick start

```bash
npm install
npm run dev
```

Open in browser:

- Client: http://localhost:5173
- Server (WebSocket): ws://localhost:8080

## Scripts

- `npm run dev`: start client and server in development mode
- `npm run build`: build all packages

## Documentation

- `GAME_DESIGN.md`
- `NETWORKING.md`
- `ARCHITECTURE.md`
- `ROADMAP.md`

## License

MIT
