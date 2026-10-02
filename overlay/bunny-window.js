const { app, BrowserWindow, screen } = require("electron");
const path = require("path");

let bunnyWindow;

// ---------------------------------------------------------------
// Tweakables
// ---------------------------------------------------------------
const BUNNY_WIDTH = 160;
const BUNNY_HEIGHT = 160;

const REACTION_MS = 350;        // delay before the bunny "notices" the cursor moved
const IDLE_RADIUS = 70;         // close enough -> stop and idle
const RUN_DISTANCE = 260;       // farther than this -> run, otherwise hop

const RUN_SPEED_MAX = 520;      // px / second
const RUN_ACCEL = 1400;         // px / second^2 (how quickly it gets up to speed)

const HOP_DURATION = 420;       // ms in the air
const HOP_DISTANCE = 70;        // px covered per hop
const HOP_REST_MIN = 120;       // ms of rest between hops (randomised)
const HOP_REST_MAX = 320;


let bunnyX = 400;
let bunnyY = 300;
let vx = 0;
let vy = 0;

let currentState = "idle";
let lastDirection = "right";

let awake = false;              // true once the bunny has noticed the cursor moved
let lastCursor = { x: -1, y: -1 };
let cursorMovedAt = 0;

let isHopping = false;
let hopStart = 0;
let hopFromX = 0;
let hopFromY = 0;
let hopToX = 0;
let hopToY = 0;
let restUntil = 0;

let lastTick = Date.now();


function createWindow() {

    bunnyWindow = new BrowserWindow({
        width: BUNNY_WIDTH,
        height: BUNNY_HEIGHT,

        frame: false,
        transparent: true,
        resizable: false,
        hasShadow: false,

        alwaysOnTop: true,
        skipTaskbar: true,

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    bunnyWindow.setIgnoreMouseEvents(true);

    bunnyWindow.loadFile(
        path.join(__dirname, "bunny.html")
    );

    bunnyWindow.setPosition(bunnyX, bunnyY);

    startTracking();
}


function setState(state) {

    if (state === currentState) {
        return;
    }

    currentState = state;

    bunnyWindow.webContents.send("bunny-state", state);
}


function updateDirection(dx) {

    if (Math.abs(dx) < 2) {
        return;
    }

    const direction = dx < 0 ? "left" : "right";

    if (direction === lastDirection) {
        return;
    }

    lastDirection = direction;

    bunnyWindow.webContents.send("bunny-direction", direction);
}


// Move `value` toward `goal` by at most `maxDelta`
function approach(value, goal, maxDelta) {

    if (value < goal) {
        return Math.min(value + maxDelta, goal);
    }

    return Math.max(value - maxDelta, goal);
}


function applyPosition() {

    bunnyWindow.setPosition(
        Math.round(bunnyX),
        Math.round(bunnyY)
    );
}


function startTracking() {

    setInterval(() => {

        if (!bunnyWindow || bunnyWindow.isDestroyed()) {
            return;
        }

        const now = Date.now();
        const dt = Math.min((now - lastTick) / 1000, 0.05);
        lastTick = now;


        // Remember when the cursor last moved
        const cursor = screen.getCursorScreenPoint();

        if (cursor.x !== lastCursor.x || cursor.y !== lastCursor.y) {
            lastCursor = cursor;
            cursorMovedAt = now;
        }


        // ---- Mid-hop: finish the hop before anything else ----
        if (isHopping) {

            const progress = Math.min(
                (now - hopStart) / HOP_DURATION,
                1
            );

            // smoothstep: push off, glide, land softly
            const eased = progress * progress * (3 - 2 * progress);

            bunnyX = hopFromX + (hopToX - hopFromX) * eased;
            bunnyY = hopFromY + (hopToY - hopFromY) * eased;

            if (progress >= 1) {
                isHopping = false;

                // Natural little pause before the next hop
                restUntil =
                    now +
                    HOP_REST_MIN +
                    Math.random() * (HOP_REST_MAX - HOP_REST_MIN);
            }

            applyPosition();
            return;
        }


        const targetX = cursor.x - BUNNY_WIDTH / 2;
        const targetY = cursor.y - BUNNY_HEIGHT / 2;

        const dx = targetX - bunnyX;
        const dy = targetY - bunnyY;

        const distance = Math.sqrt(dx * dx + dy * dy);

        updateDirection(dx);


        // ---- Close enough: settle down ----
        if (distance < IDLE_RADIUS) {

            awake = false;
            vx = 0;
            vy = 0;

            setState("idle");
            return;
        }


        // ---- Not noticed yet: wait a beat ----
        if (!awake) {

            if (now - cursorMovedAt < REACTION_MS) {
                setState("idle");
                return;
            }

            awake = true;
        }

        const ux = dx / distance;
        const uy = dy / distance;


        // ---- Far away: run, accelerating and easing off near the end ----
        if (distance >= RUN_DISTANCE) {

            setState("run");

            const speed = Math.min(
                RUN_SPEED_MAX,
                Math.max(180, distance * 3)
            );

            const maxDelta = RUN_ACCEL * dt;

            vx = approach(vx, ux * speed, maxDelta);
            vy = approach(vy, uy * speed, maxDelta);

            bunnyX += vx * dt;
            bunnyY += vy * dt;

            applyPosition();
            return;
        }


        // ---- Medium distance: hop, rest, hop ----
        vx = 0;
        vy = 0;

        if (now < restUntil) {
            setState("idle");
            return;
        }

        const step = Math.min(
            HOP_DISTANCE,
            distance - IDLE_RADIUS * 0.5
        );

        isHopping = true;
        hopStart = now;
        hopFromX = bunnyX;
        hopFromY = bunnyY;
        hopToX = bunnyX + ux * step;
        hopToY = bunnyY + uy * step;

        setState("hop");

        bunnyWindow.webContents.send("start-hop");

    }, 16);
}


app.whenReady().then(createWindow);


app.on("window-all-closed", (event) => {
    event.preventDefault();
});
