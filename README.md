# Speak — speech-to-speech app (React + Node.js)

Mic -> browser speech recognition -> (Claude via Node server) -> browser text-to-speech
using standard US / UK English system voices.

## Run

Terminal 1:
    cd server
    cp .env.example .env      # add your ANTHROPIC_API_KEY
    npm install
    npm start

Terminal 2:
    cd client
    npm install
    npm run dev

Open http://localhost:5173 in Chrome, Edge or Safari.

Modes:
- Assistant: you speak, it answers out loud.
- Repeat back: no server needed; it just speaks back what you said.
