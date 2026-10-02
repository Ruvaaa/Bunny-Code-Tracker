# Bunny Code Tracker

A small pixel bunny that keeps you company while you code.

**Bunny Code Tracker** is a VS Code extension that places a pixel bunny next to your code and follows your cursor as you move through the file.

Whether you're debugging, studying, or spending way too long in your editor, your bunny is there.

---

## Preview

### Bunny in the IDE

![Bunny Code Tracker in VS Code](assets/screenshots/bunny-in-ide.png)

The bunny stays alongside your code and follows the line where your cursor is currently positioned.

### Activating Bunny Code Tracker

Open the VS Code Command Palette with:

**`Ctrl + Shift + P`**

Then search for:

**`Bunny Code Tracker: Start`**

![Activating Bunny Code Tracker](assets/screenshots/activate-bunny.png)

---

## Features

* Pixel-art bunny companion
* Follows your cursor as you move through your code
* Designed specifically for VS Code
* Lightweight and simple
* Works directly inside the editor
* Custom pixel-art animation frames

---

## Getting Started

### 1. Open the Command Palette

Press:

```text
Ctrl + Shift + P
```

### 2. Start Bunny Code Tracker

Search for:

```text
Bunny Code Tracker: Start
```

Press **Enter**.

Your bunny will appear next to your current cursor position.

### 3. Move through your code

Move your cursor to another line and the bunny follows.

For example:

```text
Line 63 → Line 2
```

The bunny moves with you.

---

## Bunny States

The project includes several pixel-art animation frames:

| State | Frames |
| ----- | -----: |
| Idle  |      4 |
| Hop   |      6 |
| Run   |      8 |
| Sleep |      2 |

The goal is for the bunny to feel like a small character living inside your coding environment rather than simply being an icon attached to the editor.

---

## Built With

* TypeScript
* VS Code Extension API
* Node.js
* Custom pixel-art assets

---

## Project Structure

```text
bunny-code-tracker/
│
├── assets/
│   ├── bunny/
│   │   ├── idle-1.png
│   │   ├── idle-2.png
│   │   ├── idle-3.png
│   │   ├── idle-4.png
│   │   ├── hop-1.png
│   │   ├── ...
│   │   ├── run-1.png
│   │   ├── ...
│   │   └── sleep-2.png
│   │
│   └── screenshots/
│       ├── bunny-in-ide.png
│       └── activate-bunny.png
│
├── src/
│   └── extension.ts
│
├── package.json
└── README.md
```

---

## Development

Clone the repository and install the dependencies:

```bash
npm install
```

Compile the extension:

```bash
npm run compile
```

Then open the project in VS Code and press:

```text
F5
```

This launches a new **Extension Development Host** where Bunny Code Tracker can be tested.

---

## What's Next?

Bunny Code Tracker is still being developed.

Planned improvements include:

* Run animation when moving across the editor
* Hop animation for shorter movements
* Ear movement
* Blinking
* Sleeping when inactive
* More bunny states and animations
* Customization options
* Additional companion options

---

## Why I Made This

I wanted coding to feel a little less like staring at a wall of text.

So I made a bunny.

That's basically it.

A small coding companion that follows me around my editor and makes the workspace feel a little more alive.

---

## License

This project is open source. See the repository license for details.
