import * as vscode from 'vscode';

// ---------------------------------------------------------------
// Tweakables
// ---------------------------------------------------------------
const SIZE_PX = 36;            // bunny size (was 18 - the "microscopic" part)
const LINE_HEIGHT_PX = 20;     // approx editor line height, used to sit the feet on the line
const FEET_OFFSET_PX = 2;      // nudge the bunny up/down a little
const FACES_RIGHT = false;     // your overlay sprite faces LEFT by default

const LOOP_MS = 40;            // master animation loop
const REACTION_MS = 400;       // how long the bunny takes to "notice" the cursor moved
const CLOSE_ENOUGH_CHARS = 2;  // within this many characters on the same line = stay put
const RUN_FAR_CHARS = 15;      // farther than this (or...)
const RUN_FAR_LINES = 3;       // ...this many lines away = run, otherwise hop
const HOP_MOVE_MS = 380;       // one hop covers up to 2 characters every this many ms
const RUN_MOVE_MS = 70;        // run strides are quick

const ANIMATIONS = {
    idle: { prefix: 'idle', count: 4, frameMs: 250 },
    hop:  { prefix: 'hop',  count: 6, frameMs: 90 },
    run:  { prefix: 'run',  count: 8, frameMs: 70 }
} as const;

type AnimName = keyof typeof ANIMATIONS;
type Dir = 'left' | 'right';

let spriteFolder: vscode.Uri;
let bunnyVisible = false;
let bunnyEditor: vscode.TextEditor | undefined;
let bunnyPos: vscode.Position | undefined;

let loopTimer: NodeJS.Timeout | undefined;

let anim: AnimName = 'idle';
let frame = 0;
let facing: Dir = 'right';
let awake = false;               // true once the bunny has noticed the cursor moved
let lastFrameAt = 0;
let lastMoveAt = 0;
let lastCursorChangeAt = 0;

let lastDrawKey = '';
let lastDrawPos: vscode.Position | undefined;

const decorationCache = new Map<string, vscode.TextEditorDecorationType>();
let activeDecoration: vscode.TextEditorDecorationType | undefined;


export function activate(context: vscode.ExtensionContext) {

    spriteFolder = vscode.Uri.joinPath(
        context.extensionUri, 'assets', 'bunny', 'inline_cropped'
    );

    context.subscriptions.push({ dispose: disposeAll });

    context.subscriptions.push(
        vscode.commands.registerCommand('bunny-code-tracker.start', () => {
            bunnyVisible = !bunnyVisible;

            if (bunnyVisible) {
                spawnBunny(vscode.window.activeTextEditor);
                loopTimer = setInterval(loop, LOOP_MS);
            } else {
                despawnBunny();
            }
        })
    );

    // Cursor moved: the bunny doesn't react instantly, it notices after a beat
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (!bunnyVisible || event.textEditor !== vscode.window.activeTextEditor) {
                return;
            }
            if (bunnyEditor !== event.textEditor) {
                spawnBunny(event.textEditor);
                return;
            }
            lastCursorChangeAt = Date.now();
        })
    );

    // Switched editor: clear the old one, place the bunny at the cursor
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (bunnyVisible) {
                spawnBunny(editor);
            }
        })
    );
}


// ---------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------

/**
 * position: absolute removes the bunny from the text flow, so it adds
 * no height to the line (this is what stops your code shifting down).
 * translateY lifts it so its feet sit on the line; scaleX flips it.
 */
function getDecoration(
    key: string,
    uri: vscode.Uri,
    flipped: boolean
): vscode.TextEditorDecorationType {

    let deco = decorationCache.get(key);

    if (!deco) {
        const lift = SIZE_PX - LINE_HEIGHT_PX + FEET_OFFSET_PX;
        const transform =
            `translateY(${-lift}px)` + (flipped ? ' scaleX(-1)' : '');

        deco = vscode.window.createTextEditorDecorationType({
            before: {
                contentIconPath: uri,
                width: `${SIZE_PX}px`,
                height: `${SIZE_PX}px`,
                margin: `0 0 0 ${-SIZE_PX / 2}px`,
                textDecoration:
                    'none;' +
                    ' position: absolute;' +
                    ` transform: ${transform};` +
                    ' image-rendering: pixelated;' +
                    ' pointer-events: none;' +
                    ' z-index: 5;'
            }
        });

        decorationCache.set(key, deco);
    }

    return deco;
}

function render(editor: vscode.TextEditor, pos: vscode.Position) {

    const flipped = (facing === 'right') !== FACES_RIGHT;
    const key = `${anim}-${frame}-${flipped}`;

    // Nothing changed -> don't touch the editor
    if (key === lastDrawKey && lastDrawPos && lastDrawPos.isEqual(pos)) {
        return;
    }

    const def = ANIMATIONS[anim];
    const uri = vscode.Uri.joinPath(
        spriteFolder, `${def.prefix}-${frame + 1}.png`
    );

    const deco = getDecoration(key, uri, flipped);

    editor.setDecorations(deco, [new vscode.Range(pos, pos)]);

    // Clear the previous frame after drawing the new one (avoids flicker)
    if (activeDecoration && activeDecoration !== deco) {
        editor.setDecorations(activeDecoration, []);
    }

    activeDecoration = deco;
    lastDrawKey = key;
    lastDrawPos = pos;
}

function clearAll(editor: vscode.TextEditor | undefined) {
    if (editor) {
        for (const deco of decorationCache.values()) {
            editor.setDecorations(deco, []);
        }
    }
    activeDecoration = undefined;
    lastDrawKey = '';
    lastDrawPos = undefined;
}


// ---------------------------------------------------------------
// Bunny lifecycle
// ---------------------------------------------------------------

function spawnBunny(editor: vscode.TextEditor | undefined) {
    clearAll(bunnyEditor);

    bunnyEditor = editor;
    bunnyPos = editor?.selection.active;

    anim = 'idle';
    frame = 0;
    awake = false;
    lastFrameAt = lastMoveAt = lastCursorChangeAt = Date.now();

    if (editor && bunnyPos) {
        render(editor, bunnyPos);
    }
}

function despawnBunny() {
    if (loopTimer) {
        clearInterval(loopTimer);
        loopTimer = undefined;
    }
    clearAll(bunnyEditor);
    bunnyEditor = undefined;
    bunnyPos = undefined;
}

/** Bigger strides when the gap is big, always at least 1. */
function stride(distance: number, divisor: number): number {
    if (distance === 0) {
        return 0;
    }
    const magnitude = Math.min(
        Math.abs(distance),
        Math.max(1, Math.ceil(Math.abs(distance) / divisor))
    );
    return Math.sign(distance) * magnitude;
}

function loop() {

    const editor = bunnyEditor;

    if (!editor || !bunnyPos || editor !== vscode.window.activeTextEditor) {
        return;
    }

    const now = Date.now();
    const doc = editor.document;
    const target = doc.validatePosition(editor.selection.active);
    const current = doc.validatePosition(bunnyPos);

    const dLine = target.line - current.line;
    const dChar = target.character - current.character;
    const absLine = Math.abs(dLine);
    const absChar = Math.abs(dChar);

    const closeEnough = absLine === 0 && absChar <= CLOSE_ENOUGH_CHARS;

    // ---- Decide what the bunny wants to do ----
    let wanted: AnimName;

    if (closeEnough) {
        awake = false;
        wanted = 'idle';
    } else {
        // Natural delay: wait a beat after the cursor moves before reacting
        if (!awake && now - lastCursorChangeAt >= REACTION_MS) {
            awake = true;
        }

        if (!awake) {
            wanted = 'idle';
        } else if (absLine >= RUN_FAR_LINES || absChar >= RUN_FAR_CHARS) {
            wanted = 'run';
        } else {
            wanted = 'hop';
        }
    }

    if (wanted !== anim) {
        anim = wanted;
        frame = 0;
        lastFrameAt = now;
        lastMoveAt = now;   // short wind-up before the first step
    }

    // ---- Move ----
    let pos = current;

    if (anim !== 'idle') {
        const moveEvery = anim === 'run' ? RUN_MOVE_MS : HOP_MOVE_MS;

        if (now - lastMoveAt >= moveEvery) {
            lastMoveAt = now;

            const lineStep = anim === 'run'
                ? stride(dLine, 3)
                : Math.sign(dLine);

            const charStep = anim === 'run'
                ? stride(dChar, 4)
                : Math.sign(dChar) * Math.min(absChar, 2);

            let next = doc.validatePosition(
                new vscode.Position(
                    current.line + lineStep,
                    current.character + charStep
                )
            );

            // Never get stuck on short lines
            if (next.isEqual(current)) {
                next = target;
            }

            if (dChar !== 0) {
                facing = dChar > 0 ? 'right' : 'left';
            }

            pos = next;
            bunnyPos = next;
        }
    }

    // ---- Animate ----
    const def = ANIMATIONS[anim];

    if (now - lastFrameAt >= def.frameMs) {
        frame = (frame + 1) % def.count;
        lastFrameAt = now;
    }

    render(editor, pos);
}


function disposeAll() {
    despawnBunny();
    for (const deco of decorationCache.values()) {
        deco.dispose();
    }
    decorationCache.clear();
}

export function deactivate() {
    disposeAll();
}
