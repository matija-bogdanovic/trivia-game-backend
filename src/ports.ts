const protocol = window.location.protocol === "https:" ? "https" : "http";
const host = window.location.host === "localhost:3000" ? "localhost:3000":"whoisfaster.onrender.com";
export const port = `${protocol}://${host}`
export const websocketPort = window.location.protocol === "https:" ? "wss" : "ws";