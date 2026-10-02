import * as vscode from 'vscode';

// ---------------------------------------------------------------
// Tweakables
// ---------------------------------------------------------------
const SIZE_PX = 52;              // bunny box size - taller than a ~19px line on purpose
const FEET_OFFSET_PX = 3;        // + moves the bunny down, - moves it up
const FACES_RIGHT = false;       // your sprites face LEFT by default

// Monospace character width as a fraction of font size.
// Consolas ~0.55, Cascadia Code / Menlo / Courier ~0.6
const CHAR_WIDTH_RATIO = 0.55;

// The bunny is centred on its x position, so at column 0 half of it would hang
// outside the editor and get clipped. Keep its centre at least this far in.
const MIN_X = SIZE_PX / 2 + 2;

// Room between the top of an editor and the baseline of its first line. The
// bunny shrinks smoothly when it would otherwise poke out of the top and get cut off.
const TOP_ROOM_PX = 30;
const MIN_SCALE = 0.45;
const SCALE_EASE = 0.2;          // 0..1, how quickly the scale eases toward its target each tick

// Notebooks: VS Code doesn't tell extensions where cells are on screen, so the
// bunny travels through an estimated stack of cells. Measured from a real notebook:
const CELL_GAP_PX = 68;          // last line of a cell -> first line of the next = lineH + this
const OUTPUT_PADDING_PX = 16;    // chrome around each output
const MAX_OUTPUT_TEXT_LINES = 30; // VS Code collapses long text outputs after ~30 lines

const LOOP_MS = 33;              // ~30 updates per second
const REACTION_MS = 400;         // delay before the bunny "notices" the cursor moved
const IDLE_RADIUS_PX = 22;       // close enough -> stop and idle
const RUN_DISTANCE_PX = 280;     // farther than this -> run, otherwise hop

const RUN_SPEED_MAX = 520;       // px / second
const RUN_SPEED_MIN = 160;
const RUN_ACCEL = 1400;          // px / second^2

// A hop is sized relative to the bunny: ~2.5 body lengths long, and it
// rises about half its own height. Short gaps get proportionally smaller hops.
const HOP_DISTANCE_PX = SIZE_PX * 2.5;   // full-size hop length (~130px)
const HOP_ARC_PX = SIZE_PX * 0.55;       // full-size hop height (~29px)
const HOP_DURATION_MS = 480;             // full-size hop, crouch to landing
const HOP_WINDUP_FRAC = 0.22;            // crouch before takeoff (no movement)
const HOP_LAND_FRAC = 0.15;              // settle after landing (no movement)
const HOP_REST_MIN_MS = 150;             // little pause between hops (randomised)
const HOP_REST_MAX_MS = 380;

const ANIMATIONS = {
    idle: { prefix: 'idle', count: 4, frameMs: 250 },
    hop:  { prefix: 'hop',  count: 6, frameMs: 70 },
    run:  { prefix: 'run',  count: 8, frameMs: 70 }
} as const;

type AnimName = keyof typeof ANIMATIONS;
type Dir = 'left' | 'right';

/** One block of text in the bunny's "world": a whole file, or one notebook cell. */
interface Slot {
    doc: vscode.TextDocument;
    top: number;      // world y of the slot's first line
    height: number;   // lineCount * lineH
}

// While running between cells the bunny slides out of the bottom of one cell and
// in from the top of the next, instead of blinking out the moment it leaves the text.
// Kept small on purpose: a cell editor clips everything outside its own box, so
// any margin beyond the visible edge is just time the bunny spends invisible.
const ENTER_PX = 20;             // how far above a cell's first line it stays drawn
const EXIT_PX = 10;              // how far below a cell's last line (+ half a line) it stays drawn


// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
let spriteFolder: vscode.Uri;
let bunnyVisible = false;
let loopTimer: NodeJS.Timeout | undefined;
let statusItem: vscode.StatusBarItem | undefined;

// What the bunny currently lives in: one document, or one whole notebook
let bunnyScope = '';
let bunnyDoc: vscode.TextDocument | undefined;
let bunnyNotebook: vscode.NotebookDocument | undefined;

// The editor the bunny is currently drawn in (a cell editor, in notebooks)
let drawnEditor: vscode.TextEditor | undefined;

// Editor metrics (px)
let charW = 8;
let lineH = 19;

// Bunny position in world pixels (x = column * charW, y = slot top + line * lineH)
let x = MIN_X;
let y = 0;
let vx = 0;
let vy = 0;

// Last known cursor position in world pixels, and which slot (cell) it is in
let targetX = MIN_X;
let targetY = 0;
let targetIndex = 0;

let anim: AnimName = 'idle';
let frame = 0;
let facing: Dir = 'right';
let awake = false;
let lastFrameAt = 0;
let lastTick = 0;
let cursorMovedAt = 0;

let hopping = false;
let hopStart = 0;
let hopFromX = 0;
let hopFromY = 0;
let hopToX = 0;
let hopToY = 0;
let hopDuration = HOP_DURATION_MS;
let hopArc = HOP_ARC_PX;
let restUntil = 0;

// Smoothed render scale
let scaleNow = 1;

let lastSig = '';
let activeDecoration: vscode.TextEditorDecorationType | undefined;
const decorationCache = new Map<string, vscode.TextEditorDecorationType>();

let outputHeightCache = new WeakMap<vscode.NotebookCellOutput, number>();


export function activate(context: vscode.ExtensionContext) {

    spriteFolder = vscode.Uri.joinPath(
        context.extensionUri, 'assets', 'bunny', 'inline_cropped'
    );

    readMetrics();

    context.subscriptions.push({ dispose: disposeAll });

    // Status bar button: click to switch the bunny on / off for this window.
    // Once on, it follows you into every file and notebook in the window.
    statusItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusItem.command = 'bunny-code-tracker.start';
    updateStatusItem();
    statusItem.show();
    context.subscriptions.push(statusItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('bunny-code-tracker.start', () => {
            setBunny(!bunnyVisible);
        })
    );

    // Auto start: bring the bunny up as soon as VS Code opens (can be turned off
    // in settings). If no editor is open yet, the loop picks one up when it is.
    const autoStart = vscode.workspace
        .getConfiguration('bunnyCodeTracker')
        .get<boolean>('autoStart', true);

    if (autoStart) {
        setBunny(true);
    }

    // Cursor moved: remember when, the bunny notices after a beat
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (!bunnyVisible || event.textEditor !== vscode.window.activeTextEditor) {
                return;
            }
            if (scopeOf(event.textEditor.document).key !== bunnyScope) {
                spawnBunny(event.textEditor);
                return;
            }
            cursorMovedAt = Date.now();
        })
    );

    // Switched editor. Moving to another cell of the SAME notebook (or another
    // editor on the same file) is not a teleport: the bunny runs there.
    // Only a different file / notebook respawns it.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!bunnyVisible || !editor) {
                return;
            }
            if (scopeOf(editor.document).key !== bunnyScope) {
                spawnBunny(editor);
            } else {
                cursorMovedAt = Date.now();
            }
        })
    );

    // Font size / line height changed -> recompute metrics
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (
                e.affectsConfiguration('editor.fontSize') ||
                e.affectsConfiguration('editor.lineHeight')
            ) {
                readMetrics();
            }
        })
    );
}


/** Switch the bunny on or off for this whole window (all files and notebooks). */
function setBunny(on: boolean) {
    if (on === bunnyVisible) {
        return;
    }
    bunnyVisible = on;

    if (bunnyVisible) {
        spawnBunny(vscode.window.activeTextEditor);
        loopTimer = setInterval(loop, LOOP_MS);
    } else {
        despawnBunny();
    }

    updateStatusItem();
}

function updateStatusItem() {
    if (!statusItem) {
        return;
    }
    statusItem.text = bunnyVisible ? '🐰 Bunny: On' : '🐰 Bunny: Off';
    statusItem.tooltip = bunnyVisible
        ? 'Click to hide the bunny in this window'
        : 'Click to show the bunny in this window';
}


// ---------------------------------------------------------------
// Editor metrics
// ---------------------------------------------------------------
function readMetrics() {
    const cfg = vscode.workspace.getConfiguration('editor');

    const fontSize = cfg.get<number>('fontSize', 14);
    const lineHeight = cfg.get<number>('lineHeight', 0);

    if (lineHeight === 0) {
        // VS Code's automatic line height
        const ratio = process.platform === 'darwin' ? 1.5 : 1.35;
        lineH = Math.round(ratio * fontSize);
    } else if (lineHeight < 8) {
        lineH = Math.round(lineHeight * fontSize);   // multiplier
    } else {
        lineH = lineHeight;                          // pixels
    }

    charW = fontSize * CHAR_WIDTH_RATIO;

    // Output heights depend on lineH
    outputHeightCache = new WeakMap();
}


// ---------------------------------------------------------------
// World layout (single file or stacked notebook cells)
// ---------------------------------------------------------------

/** Which notebook (if any) a document is a cell of. */
function notebookOf(doc: vscode.TextDocument): vscode.NotebookDocument | undefined {
    if (doc.uri.scheme !== 'vscode-notebook-cell') {
        return undefined;
    }
    const key = doc.uri.toString();
    return vscode.workspace.notebookDocuments.find(nb =>
        nb.getCells().some(cell => cell.document.uri.toString() === key)
    );
}

function scopeOf(doc: vscode.TextDocument) {
    const notebook = notebookOf(doc);
    return {
        key: notebook ? `nb:${notebook.uri.toString()}` : `doc:${doc.uri.toString()}`,
        notebook
    };
}

/** Estimated on-screen height of one cell output (px). */
function outputHeight(out: vscode.NotebookCellOutput): number {
    const cached = outputHeightCache.get(out);
    if (cached !== undefined) {
        return cached;
    }
    const h = computeOutputHeight(out) + OUTPUT_PADDING_PX;
    outputHeightCache.set(out, h);
    return h;
}

function computeOutputHeight(out: vscode.NotebookCellOutput): number {

    // VS Code shows the richest representation; mirror its preference order
    const preference: Array<(mime: string) => boolean> = [
        m => m.startsWith('image/'),
        m => m === 'text/html',
        m => m === 'application/vnd.code.notebook.error',
        m => m === 'application/vnd.code.notebook.stdout' ||
             m === 'application/vnd.code.notebook.stderr',
        m => m.startsWith('text/')
    ];

    let item: vscode.NotebookCellOutputItem | undefined;
    for (const test of preference) {
        item = out.items.find(i => test(i.mime));
        if (item) {
            break;
        }
    }
    item = item ?? out.items[0];

    if (!item) {
        return 0;
    }

    try {
        const mime = item.mime;
        const data = item.data;

        if (mime === 'image/png' && data.length >= 24) {
            // PNG header: width at byte 16, height at byte 20 (big-endian)
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            return Math.min(view.getUint32(20), 1600);
        }
        if (mime.startsWith('image/')) {
            return 300;
        }

        const isText =
            mime.startsWith('text/') ||
            mime.startsWith('application/vnd.code.notebook.') ||
            mime === 'application/json';

        if (!isText) {
            return 100;
        }

        const text = new TextDecoder().decode(data).replace(/\n+$/, '');

        if (mime === 'text/html') {
            const rows = (text.match(/<tr/gi) || []).length;
            return rows > 0 ? Math.min(rows * (lineH + 6), 1200) : 80;
        }

        let lines = text.split('\n').length;

        if (mime === 'application/vnd.code.notebook.error') {
            try {
                const err = JSON.parse(text);
                lines = String(err.stack || err.message || '').split('\n').length;
            } catch {
                // keep the raw line count
            }
        }

        return Math.min(lines, MAX_OUTPUT_TEXT_LINES) * lineH;

    } catch {
        return 100;
    }
}

/** Lay every cell out top to bottom, with measured gaps and estimated output heights. */
function getSlots(): Slot[] {

    if (bunnyNotebook && !bunnyNotebook.isClosed) {
        const slots: Slot[] = [];
        let top = 0;

        for (const cell of bunnyNotebook.getCells()) {
            const height = cell.document.lineCount * lineH;

            let outputs = 0;
            for (const out of cell.outputs) {
                outputs += outputHeight(out);
            }

            slots.push({ doc: cell.document, top, height });
            top += height + CELL_GAP_PX + outputs;
        }
        return slots;
    }

    if (bunnyDoc) {
        return [{ doc: bunnyDoc, top: 0, height: bunnyDoc.lineCount * lineH }];
    }

    return [];
}

function slotIndexFor(slots: Slot[], doc: vscode.TextDocument): number {
    const key = doc.uri.toString();
    return slots.findIndex(s => s.doc.uri.toString() === key);
}

/** Which slot is world position `worldY` in? Includes the slide-in / slide-out margins. */
function findSlotAt(slots: Slot[], worldY: number) {
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const rel = worldY - s.top;
        if (rel >= -ENTER_PX && rel < s.height - lineH * 0.5 + EXIT_PX) {
            return { slot: s, rel, index: i };
        }
    }
    return undefined;
}

/**
 * The bunny is currently in dead space (the gap or outputs between two cells),
 * where nothing can be drawn. Move it to the edge of the next cell in the
 * direction of travel so it keeps running without a long invisible stretch.
 */
function skipGap(slots: Slot[], dir: 1 | -1) {
    if (dir > 0) {
        // Heading down: stop just above the next cell's first line
        const next = slots.find(s => s.top - ENTER_PX > y);
        if (next) {
            y = next.top - ENTER_PX;
        }
    } else {
        // Heading up: re-enter at the bottom edge of the nearest cell above
        for (let i = slots.length - 1; i >= 0; i--) {
            const s = slots[i];
            const bottom = s.top + s.height - lineH * 0.5 + EXIT_PX;
            if (bottom <= y) {
                y = bottom - 0.01;
                break;
            }
        }
    }
}

/** The editor currently showing a document (a cell editor exists only while the cell is on screen). */
function editorFor(doc: vscode.TextDocument): vscode.TextEditor | undefined {
    const key = doc.uri.toString();

    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.toString() === key) {
        return active;
    }

    return vscode.window.visibleTextEditors.find(
        e => e.document.uri.toString() === key
    );
}


// ---------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------

/**
 * One decoration type per sprite frame. The type holds everything that
 * never changes. `position: absolute` takes the bunny out of the text
 * flow (no line shifting) and, because it's inline-level, its feet land
 * on the text baseline of the line it's attached to.
 *
 * Position/flip/scale are applied per instance in render(), so the bunny
 * can sit at any pixel, not just on character boundaries.
 */
function getDecoration(
    key: string,
    uri: vscode.Uri
): vscode.TextEditorDecorationType {

    let deco = decorationCache.get(key);

    if (!deco) {
        deco = vscode.window.createTextEditorDecorationType({
            before: {
                contentIconPath: uri,
                width: `${SIZE_PX}px`,
                height: `${SIZE_PX}px`,
                margin: `0 0 0 ${-SIZE_PX / 2}px`,
                textDecoration:
                    'none;' +
                    ' position: absolute;' +
                    ' transform-origin: center bottom;' +
                    ' object-fit: contain;' +
                    ' object-position: center bottom;' +
                    ' image-rendering: pixelated;' +
                    ' pointer-events: none;' +
                    ' z-index: 5;'
            }
        });

        decorationCache.set(key, deco);
    }

    return deco;
}

function clearAll(editor: vscode.TextEditor | undefined) {
    if (editor) {
        for (const deco of decorationCache.values()) {
            editor.setDecorations(deco, []);
        }
    }
    activeDecoration = undefined;
    lastSig = '';
}

/** Bunny is in a cell that isn't on screen (or has no editor): draw nothing. */
function hide() {
    if (drawnEditor || activeDecoration) {
        clearAll(drawnEditor);
        drawnEditor = undefined;
    }
}

function render(slots: Slot[], arc: number) {

    const hit = findSlotAt(slots, y);

    // Nowhere near any cell (e.g. deep inside a tall output): invisible, still running
    if (!hit) {
        hide();
        return;
    }

    const { slot, rel } = hit;
    const editor = editorFor(slot.doc);

    // That cell is scrolled out of view
    if (!editor) {
        hide();
        return;
    }

    // Moved into a different cell editor: take the bunny off the old one
    if (drawnEditor !== editor) {
        clearAll(drawnEditor);
        drawnEditor = editor;
    }

    const doc = slot.doc;

    const line = Math.max(
        0,
        Math.min(doc.lineCount - 1, Math.round(rel / lineH))
    );

    // Character the bunny is attached to, and the pixel offset from it
    const col = Math.floor(Math.max(x, 0) / charW);
    const pos = doc.validatePosition(new vscode.Position(line, col));

    let dx = x - pos.character * charW;
    // Past the end of a line the offset can get large: round coarsely so
    // we don't create hundreds of distinct CSS rules.
    dx = dx <= charW * 1.5 ? Math.round(dx) : Math.round(dx / 6) * 6;

    // Vertical offset from the attached line. Beyond the first / last line this
    // grows, so the bunny slides in from above / out below (clipped by the cell).
    const dyRaw = rel - line * lineH;
    const dy = Math.round((dyRaw - arc + FEET_OFFSET_PX) / 2) * 2;

    // Shrink a little near the top of a plain file so its head isn't cut off.
    // Never in notebooks: the bunny keeps sliding in from above each cell there,
    // which would otherwise read as shrinking. Changes are eased, not snapped.
    const room = TOP_ROOM_PX + rel - arc;
    const wanted = bunnyNotebook
        ? 1
        : Math.max(MIN_SCALE, Math.min(1, room / SIZE_PX));

    scaleNow += (wanted - scaleNow) * SCALE_EASE;
    const scale = Math.round(scaleNow * 20) / 20;

    const flipped = (facing === 'right') !== FACES_RIGHT;
    const key = `${anim}-${frame}`;

    const sig = `${key}|${pos.line}|${pos.character}|${dx}|${dy}|${scale}|${flipped}`;
    if (sig === lastSig) {
        return;   // nothing visibly changed
    }
    lastSig = sig;

    const def = ANIMATIONS[anim];
    const uri = vscode.Uri.joinPath(
        spriteFolder, `${def.prefix}-${frame + 1}.png`
    );

    const deco = getDecoration(key, uri);

    editor.setDecorations(deco, [
        {
            range: new vscode.Range(pos, pos),
            renderOptions: {
                before: {
                    margin: `0 0 0 ${-SIZE_PX / 2 + dx}px`,
                    textDecoration:
                        `none; transform: translateY(${dy}px)` +
                        ` scale(${flipped ? -scale : scale}, ${scale});`
                }
            }
        }
    ]);

    // Clear the previous frame after drawing the new one (avoids flicker)
    if (activeDecoration && activeDecoration !== deco) {
        editor.setDecorations(activeDecoration, []);
    }

    activeDecoration = deco;
}


// ---------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------
function spawnBunny(editor: vscode.TextEditor | undefined) {
    clearAll(drawnEditor);
    drawnEditor = undefined;

    const now = Date.now();
    anim = 'idle';
    frame = 0;
    awake = false;
    hopping = false;
    vx = vy = 0;
    scaleNow = 1;
    lastFrameAt = lastTick = cursorMovedAt = now;

    if (!editor) {
        bunnyScope = '';
        bunnyDoc = undefined;
        bunnyNotebook = undefined;
        return;
    }

    const scope = scopeOf(editor.document);
    bunnyScope = scope.key;
    bunnyNotebook = scope.notebook;
    bunnyDoc = editor.document;

    // Appear right at the cursor
    const slots = getSlots();
    const index = slotIndexFor(slots, editor.document);

    if (index >= 0) {
        const cursor = editor.selection.active;
        targetIndex = index;
        x = targetX = Math.max(cursor.character * charW, MIN_X);
        y = targetY = slots[index].top + cursor.line * lineH;
        render(slots, 0);
    }
}

function despawnBunny() {
    if (loopTimer) {
        clearInterval(loopTimer);
        loopTimer = undefined;
    }
    clearAll(drawnEditor);
    drawnEditor = undefined;
    bunnyScope = '';
    bunnyDoc = undefined;
    bunnyNotebook = undefined;
}

function setAnim(name: AnimName, now: number) {
    if (name !== anim) {
        anim = name;
        frame = 0;
        lastFrameAt = now;
    }
}

function approach(value: number, goal: number, maxDelta: number): number {
    return value < goal
        ? Math.min(value + maxDelta, goal)
        : Math.max(value - maxDelta, goal);
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}


// ---------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------
function loop() {

    if (!bunnyDoc) {
        // Started with no editor open: pick one up as soon as there is one
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            spawnBunny(editor);
        }
        return;
    }

    const now = Date.now();
    const dt = Math.min((now - lastTick) / 1000, 0.05);
    lastTick = now;

    const slots = getSlots();

    // Where's the cursor? (If focus isn't in a cell editor, keep the last spot.)
    const active = vscode.window.activeTextEditor;
    if (active) {
        const index = slotIndexFor(slots, active.document);
        if (index >= 0) {
            const cursor = active.document.validatePosition(active.selection.active);
            targetIndex = index;
            targetX = Math.max(cursor.character * charW, MIN_X);
            targetY = slots[index].top + cursor.line * lineH;
        }
    }

    let arc = 0;

    if (hopping) {

        // A real hop: crouch (no movement), launch, glide at constant speed
        // while the arc rises and falls, then settle (no movement).
        const p = clamp01((now - hopStart) / hopDuration);
        const air = clamp01(
            (p - HOP_WINDUP_FRAC) / (1 - HOP_WINDUP_FRAC - HOP_LAND_FRAC)
        );

        x = hopFromX + (hopToX - hopFromX) * air;
        y = hopFromY + (hopToY - hopFromY) * air;
        arc = Math.sin(air * Math.PI) * hopArc;

        // Sprite frames follow the hop's progress
        frame = Math.min(ANIMATIONS.hop.count - 1, Math.floor(p * ANIMATIONS.hop.count));

        if (p >= 1) {
            hopping = false;
            arc = 0;
            restUntil =
                now +
                HOP_REST_MIN_MS +
                Math.random() * (HOP_REST_MAX_MS - HOP_REST_MIN_MS);
            setAnim('idle', now);
        }

    } else {

        const dx = targetX - x;
        const dy = targetY - y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (Math.abs(dx) >= 4) {
            facing = dx < 0 ? 'left' : 'right';
        }

        // Is the cursor in a different cell from the one the bunny is standing in?
        const current = findSlotAt(slots, y);
        const crossing = !current || current.index !== targetIndex;

        // Just jumped into the target cell and still outside its text (above the
        // first line / below the last)? Keep running in, don't start a slow hop.
        const atEdge =
            !!current &&
            (current.rel < 0 || current.rel > current.slot.height - lineH);

        if (dist < IDLE_RADIUS_PX) {

            // Close enough: settle down
            awake = false;
            vx = vy = 0;
            setAnim('idle', now);

        } else {

            // Natural delay before reacting
            if (!awake && now - cursorMovedAt >= REACTION_MS) {
                awake = true;
            }

            if (!awake) {

                setAnim('idle', now);

            } else if (dist >= RUN_DISTANCE_PX || crossing || atEdge) {

                // Far away, or another cell: always RUN. (A hop would carry it
                // out of sight in the middle of the gap and look like teleporting.)
                setAnim('run', now);

                const speed = Math.min(
                    RUN_SPEED_MAX,
                    Math.max(RUN_SPEED_MIN, dist * 3)
                );
                const maxDelta = RUN_ACCEL * dt;

                vx = approach(vx, (dx / dist) * speed, maxDelta);
                vy = approach(vy, (dy / dist) * speed, maxDelta);

                x += vx * dt;
                y += vy * dt;

                // The bunny can only be drawn inside a cell editor, so the gap and
                // outputs between cells are invisible. Skip over them: the bunny
                // slides out of one cell and straight into the next.
                if (crossing && !findSlotAt(slots, y)) {
                    skipGap(slots, dy > 0 ? 1 : -1);
                }

            } else {

                // Medium distance: hop, rest, hop
                vx = vy = 0;

                if (now < restUntil) {
                    setAnim('idle', now);
                } else {
                    // Land on the cursor if it's close, otherwise take a full hop.
                    const step = Math.min(HOP_DISTANCE_PX, dist);

                    // Shorter hops are lower and quicker, like a real bunny's
                    const ratio = step / HOP_DISTANCE_PX;
                    hopArc = HOP_ARC_PX * Math.max(0.45, ratio);
                    hopDuration = HOP_DURATION_MS * (0.75 + 0.25 * ratio);

                    hopping = true;
                    hopStart = now;
                    hopFromX = x;
                    hopFromY = y;
                    hopToX = x + (dx / dist) * step;
                    hopToY = y + (dy / dist) * step;

                    setAnim('hop', now);
                }
            }
        }
    }

    // Never let the bunny's centre go left of the editor edge (it'd be clipped away)
    if (x < MIN_X) {
        x = MIN_X;
    }

    // Idle / run cycle their frames on a timer (hop is driven by progress)
    if (anim !== 'hop') {
        const def = ANIMATIONS[anim];
        if (now - lastFrameAt >= def.frameMs) {
            frame = (frame + 1) % def.count;
            lastFrameAt = now;
        }
    }

    render(slots, arc);
}


function disposeAll() {
    despawnBunny();
    statusItem = undefined;
    for (const deco of decorationCache.values()) {
        deco.dispose();
    }
    decorationCache.clear();
}

export function deactivate() {
    disposeAll();
}