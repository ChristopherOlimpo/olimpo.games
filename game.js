(() => {
    "use strict";

    const SIZE = 4;
    const WIN_VALUE = 2048;
    const STORAGE_BEST = "2048_best";
    const STORAGE_STATE = "2048_state";

    const boardEl = document.getElementById("board");
    const gridEl = document.getElementById("grid");
    const tilesEl = document.getElementById("tiles");
    const scoreEl = document.getElementById("score");
    const bestEl = document.getElementById("best");
    const overlayEl = document.getElementById("overlay");
    const overlayTitle = document.getElementById("overlay-title");
    const overlaySub = document.getElementById("overlay-sub");
    const keepGoingBtn = document.getElementById("keep-going");
    const tryAgainBtn = document.getElementById("try-again");
    const undoBtn = document.getElementById("undo");
    const restartBtn = document.getElementById("restart");

    // Build static grid backdrop
    for (let i = 0; i < SIZE * SIZE; i++) {
        const c = document.createElement("div");
        c.className = "cell";
        gridEl.appendChild(c);
    }

    let state;
    let prevSnapshot = null; // for undo
    let best = Number(localStorage.getItem(STORAGE_BEST) || 0);
    let busy = false;
    let tileEls = new Map(); // id -> element

    bestEl.textContent = best;

    // ---------- Tile model ----------
    class Tile {
        constructor(value, row, col, id) {
            this.id = id;
            this.value = value;
            this.row = row;
            this.col = col;
            this.merged = false;
            this.mergedFromIds = null;
            this.isNew = false;
        }
    }

    function emptyGrid() {
        const g = new Array(SIZE);
        for (let r = 0; r < SIZE; r++) g[r] = new Array(SIZE).fill(null);
        return g;
    }

    function newGame() {
        state = {
            grid: emptyGrid(),
            score: 0,
            nextId: 1,
            won: false,
            keepGoing: false,
        };
        prevSnapshot = null;
        updateUndoButton();
        clearTileEls();
        spawnRandomTile();
        spawnRandomTile();
        renderAll();
        hideOverlay();
        writeScore();
        saveState();
    }

    function clearTileEls() {
        tilesEl.innerHTML = "";
        tileEls = new Map();
    }

    function spawnRandomTile() {
        const empties = [];
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (!state.grid[r][c]) empties.push([r, c]);
            }
        }
        if (empties.length === 0) return null;
        const [r, c] = empties[Math.floor(Math.random() * empties.length)];
        const value = Math.random() < 0.9 ? 2 : 4;
        const t = new Tile(value, r, c, state.nextId++);
        t.isNew = true;
        state.grid[r][c] = t;
        return t;
    }

    // ---------- Movement ----------
    function move(direction) {
        if (busy) return;
        if (!overlayEl.hidden && !state.keepGoing) return;

        forEachTile((t) => {
            t.merged = false;
            t.mergedFromIds = null;
            t.isNew = false;
        });

        const snapshot = serialize(state);
        let moved = false;
        let gained = 0;
        const absorbed = []; // Tile objects sliding into a merge target, slated for removal

        const traversals = buildTraversals(direction);
        const vec = vectorFor(direction);

        for (const r of traversals.rows) {
            for (const c of traversals.cols) {
                const tile = state.grid[r][c];
                if (!tile) continue;
                const { farthest, next } = findFarthest(r, c, vec);
                const nextTile = next ? state.grid[next.r][next.c] : null;

                if (nextTile && nextTile.value === tile.value && !nextTile.merged) {
                    // Merge into nextTile
                    state.grid[r][c] = null;
                    const newValue = tile.value * 2;
                    nextTile.value = newValue;
                    nextTile.merged = true;
                    nextTile.mergedFromIds = [tile.id, nextTile.id];

                    tile.row = next.r;
                    tile.col = next.c;
                    absorbed.push(tile);

                    gained += newValue;
                    moved = true;
                    if (newValue === WIN_VALUE && !state.won) state.won = true;
                } else if (farthest.r !== r || farthest.c !== c) {
                    state.grid[r][c] = null;
                    state.grid[farthest.r][farthest.c] = tile;
                    tile.row = farthest.r;
                    tile.col = farthest.c;
                    moved = true;
                }
            }
        }

        if (!moved) return;

        prevSnapshot = snapshot;
        updateUndoButton();
        addScore(gained);

        // Animate moves: re-position every existing tile element (in-grid + absorbed sliding to merge cell)
        forEachTile((t) => {
            const el = tileEls.get(t.id);
            if (el) positionTileEl(el, t);
        });
        for (const t of absorbed) {
            const el = tileEls.get(t.id);
            if (el) positionTileEl(el, t);
        }

        busy = true;
        const anim = readAnimMs();
        window.setTimeout(() => {
            // Remove absorbed tiles
            for (const t of absorbed) {
                const el = tileEls.get(t.id);
                if (el && el.parentNode) el.parentNode.removeChild(el);
                tileEls.delete(t.id);
            }
            // Pop merged tiles
            forEachTile((t) => {
                if (t.mergedFromIds) {
                    const el = tileEls.get(t.id);
                    if (el) {
                        applyTileVisual(el, t);
                        el.classList.remove("appear");
                        el.classList.remove("pop");
                        void el.offsetWidth;
                        el.classList.add("pop");
                    }
                }
            });
            // Spawn new tile
            const spawned = spawnRandomTile();
            if (spawned) createTileEl(spawned);
            busy = false;
            saveState();
            checkEndState();
        }, anim + 10);
    }

    function readAnimMs() {
        const v = getComputedStyle(document.documentElement).getPropertyValue("--anim").trim();
        if (v.endsWith("ms")) return parseFloat(v);
        if (v.endsWith("s")) return parseFloat(v) * 1000;
        return 140;
    }

    function vectorFor(dir) {
        switch (dir) {
            case "left":  return { dr: 0,  dc: -1 };
            case "right": return { dr: 0,  dc: 1 };
            case "up":    return { dr: -1, dc: 0 };
            case "down":  return { dr: 1,  dc: 0 };
        }
    }

    function buildTraversals(dir) {
        const rows = [], cols = [];
        for (let i = 0; i < SIZE; i++) { rows.push(i); cols.push(i); }
        if (dir === "right") cols.reverse();
        if (dir === "down")  rows.reverse();
        return { rows, cols };
    }

    function findFarthest(r, c, vec) {
        let pr = r, pc = c;
        let nr = r + vec.dr, nc = c + vec.dc;
        while (inBounds(nr, nc) && !state.grid[nr][nc]) {
            pr = nr; pc = nc;
            nr += vec.dr; nc += vec.dc;
        }
        return {
            farthest: { r: pr, c: pc },
            next: inBounds(nr, nc) ? { r: nr, c: nc } : null,
        };
    }

    function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

    function forEachTile(fn) {
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const t = state.grid[r][c];
                if (t) fn(t);
            }
        }
    }

    // ---------- Rendering ----------
    function renderAll() {
        // Create/position elements for every tile currently in state.
        forEachTile((t) => {
            let el = tileEls.get(t.id);
            if (!el) {
                el = createTileEl(t);
            } else {
                applyTileVisual(el, t);
                positionTileEl(el, t);
            }
        });
    }

    function createTileEl(tile) {
        const el = document.createElement("div");
        el.className = "tile";
        applyTileVisual(el, tile);
        positionTileEl(el, tile);
        if (tile.isNew) {
            el.classList.add("appear");
            el.addEventListener("animationend", () => el.classList.remove("appear"), { once: true });
        }
        tilesEl.appendChild(el);
        tileEls.set(tile.id, el);
        return el;
    }

    function applyTileVisual(el, tile) {
        el.className = "tile";
        const cls = tile.value <= 2048 ? `tile-${tile.value}` : "tile-super";
        el.classList.add(cls);
        el.textContent = tile.value;
    }

    function positionTileEl(el, tile) {
        const x = `calc((var(--cell) + var(--gap)) * ${tile.col})`;
        const y = `calc((var(--cell) + var(--gap)) * ${tile.row})`;
        el.style.setProperty("--x", x);
        el.style.setProperty("--y", y);
        el.style.transform = `translate(${x}, ${y})`;
    }

    // ---------- Score ----------
    function addScore(delta) {
        if (!delta) return;
        state.score += delta;
        const d = document.createElement("span");
        d.className = "delta";
        d.textContent = "+" + delta;
        scoreEl.appendChild(d);
        window.setTimeout(() => d.remove(), 650);
        writeScore();
    }

    function writeScore() {
        // Preserve any .delta children, only update the text node.
        let textNode = null;
        for (const n of scoreEl.childNodes) {
            if (n.nodeType === Node.TEXT_NODE) { textNode = n; break; }
        }
        if (!textNode) {
            textNode = document.createTextNode("");
            scoreEl.insertBefore(textNode, scoreEl.firstChild);
        }
        textNode.nodeValue = String(state.score);

        if (state.score > best) {
            best = state.score;
            localStorage.setItem(STORAGE_BEST, String(best));
            bestEl.textContent = best;
        }
    }

    // ---------- End / overlay ----------
    function checkEndState() {
        if (state.won && !state.keepGoing) {
            showOverlay({ title: "You win!", sub: `You reached ${WIN_VALUE}.`, showKeepGoing: true });
            return;
        }
        if (!hasMoves()) {
            showOverlay({ title: "Game over", sub: `Final score: ${state.score}`, showKeepGoing: false });
        }
    }

    function hasMoves() {
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const t = state.grid[r][c];
                if (!t) return true;
                if (r + 1 < SIZE) {
                    const n = state.grid[r + 1][c];
                    if (n && n.value === t.value) return true;
                }
                if (c + 1 < SIZE) {
                    const n = state.grid[r][c + 1];
                    if (n && n.value === t.value) return true;
                }
            }
        }
        return false;
    }

    function showOverlay({ title, sub, showKeepGoing }) {
        overlayTitle.textContent = title;
        overlaySub.textContent = sub;
        keepGoingBtn.hidden = !showKeepGoing;
        overlayEl.hidden = false;
    }
    function hideOverlay() { overlayEl.hidden = true; }

    // ---------- Persistence / undo ----------
    function serialize(s) {
        const cells = [];
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const t = s.grid[r][c];
                cells.push(t ? { id: t.id, value: t.value, r, c } : null);
            }
        }
        return { cells, score: s.score, nextId: s.nextId, won: s.won, keepGoing: s.keepGoing };
    }

    function applySnapshot(data) {
        // Rebuild state, reusing DOM elements when possible for smooth visuals.
        const grid = emptyGrid();
        const aliveIds = new Set();
        for (const cell of data.cells) {
            if (!cell) continue;
            const t = new Tile(cell.value, cell.r, cell.c, cell.id);
            grid[cell.r][cell.c] = t;
            aliveIds.add(cell.id);
        }
        state.grid = grid;
        state.score = data.score;
        state.nextId = data.nextId;
        state.won = data.won;
        state.keepGoing = data.keepGoing;

        // Remove dead tile elements
        for (const [id, el] of Array.from(tileEls.entries())) {
            if (!aliveIds.has(id)) {
                if (el.parentNode) el.parentNode.removeChild(el);
                tileEls.delete(id);
            }
        }
        // Position/update alive
        forEachTile((t) => {
            let el = tileEls.get(t.id);
            if (!el) {
                el = document.createElement("div");
                el.className = "tile";
                tilesEl.appendChild(el);
                tileEls.set(t.id, el);
            }
            applyTileVisual(el, t);
            positionTileEl(el, t);
        });
        writeScore();
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_STATE, JSON.stringify(serialize(state)));
        } catch (_) { /* ignore */ }
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_STATE);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data || !Array.isArray(data.cells) || data.cells.length !== SIZE * SIZE) return false;
            state = {
                grid: emptyGrid(),
                score: 0,
                nextId: data.nextId || 1,
                won: !!data.won,
                keepGoing: !!data.keepGoing,
            };
            clearTileEls();
            applySnapshot(data);
            prevSnapshot = null;
            updateUndoButton();
            hideOverlay();
            return true;
        } catch (_) {
            return false;
        }
    }

    function undo() {
        if (busy || !prevSnapshot) return;
        applySnapshot(prevSnapshot);
        prevSnapshot = null;
        updateUndoButton();
        hideOverlay();
        saveState();
    }

    function updateUndoButton() {
        undoBtn.disabled = !prevSnapshot;
    }

    // ---------- Input ----------
    const KEY_TO_DIR = {
        ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
        a: "left", d: "right", w: "up", s: "down",
        A: "left", D: "right", W: "up", S: "down",
        h: "left", l: "right", k: "up", j: "down", // vim
    };

    window.addEventListener("keydown", (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "z" || e.key === "Z") { e.preventDefault(); undo(); return; }
        if (e.key === "r" || e.key === "R") { e.preventDefault(); newGame(); return; }
        const dir = KEY_TO_DIR[e.key];
        if (dir) {
            e.preventDefault();
            move(dir);
        }
    });

    // Swipe
    let touchStart = null;
    boardEl.addEventListener("touchstart", (e) => {
        const t = e.changedTouches[0];
        touchStart = { x: t.clientX, y: t.clientY };
    }, { passive: true });

    boardEl.addEventListener("touchend", (e) => {
        if (!touchStart) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStart.x;
        const dy = t.clientY - touchStart.y;
        touchStart = null;
        const absX = Math.abs(dx), absY = Math.abs(dy);
        const threshold = 24;
        if (Math.max(absX, absY) < threshold) return;
        if (absX > absY) move(dx > 0 ? "right" : "left");
        else move(dy > 0 ? "down" : "up");
    });

    // Mouse drag (also acts as swipe on desktop trackpad)
    let mouseStart = null;
    boardEl.addEventListener("mousedown", (e) => {
        mouseStart = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("mouseup", (e) => {
        if (!mouseStart) return;
        const dx = e.clientX - mouseStart.x;
        const dy = e.clientY - mouseStart.y;
        mouseStart = null;
        const absX = Math.abs(dx), absY = Math.abs(dy);
        const threshold = 30;
        if (Math.max(absX, absY) < threshold) return;
        if (absX > absY) move(dx > 0 ? "right" : "left");
        else move(dy > 0 ? "down" : "up");
    });

    // Buttons
    restartBtn.addEventListener("click", () => newGame());
    tryAgainBtn.addEventListener("click", () => newGame());
    undoBtn.addEventListener("click", () => undo());
    keepGoingBtn.addEventListener("click", () => {
        state.keepGoing = true;
        hideOverlay();
        saveState();
    });

    // Prevent page scroll from arrow keys while focused on body
    window.addEventListener("keydown", (e) => {
        if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) e.preventDefault();
    }, { passive: false });

    // Boot
    if (!loadState()) {
        newGame();
    }
    boardEl.focus({ preventScroll: true });
})();
