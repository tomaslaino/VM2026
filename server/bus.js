import { EventEmitter } from "node:events";

/*
  Intern händelsebuss. Faserna (live-polling, slutkontroll) sänder
  uppdateringar hit, och WebSocket-servern lyssnar och pushar vidare
  till alla anslutna webbläsare.

  Kanaler:
    "broadcast" -> { type, payload } som skickas till alla klienter
*/
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export function broadcast(type, payload) {
  bus.emit("broadcast", { type, payload, ts: Date.now() });
}
