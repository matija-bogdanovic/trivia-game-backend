export const classes = {
    // Websocket connection
    wss: new WebSocket("ws://localhost:3000/game"),
    // Localstorage username
    localStorageUsername: localStorage.getItem("username"),
    // Grab client id
    clientId: localStorage.getItem("clientId"),
    // Get the first username wherever you want to display it
    username1: document.querySelectorAll('[aria-label="1st"]'),
    // Get every second username where you want to display it
    username2: document.querySelectorAll('[aria-label="2nd"]'),
    overlay: document.getElementById("overlay"),
    countdown: document.getElementById("countDown"),
    heart: document.createElement("img"),
    // Start the game button
    button: document.getElementById("startButton"),
    // Heart Wrapper
    heartWrapPlayer1: document.getElementById("heartWrap1"),
    heartWrapPlayer2: document.getElementById("heartWrap2"),
    circle: document.getElementById("circle"),
};
//# sourceMappingURL=variables.js.map