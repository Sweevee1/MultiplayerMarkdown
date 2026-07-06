import * as Y from "yjs";
import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import type { DecorationSet, PluginValue, ViewUpdate } from "@codemirror/view";
import { Annotation } from "@codemirror/state";
import { ySyncFacet, type YSyncConfig } from "y-codemirror.next";

/**
 * Hardened drop-in replacement for y-codemirror.next's yRemoteSelections.
 *
 * The upstream plugin turns a remote peer's Yjs relative cursor position
 * into an absolute CM6 index (Y.createAbsolutePositionFromRelativePosition)
 * and calls `doc.lineAt(pos)` on it with no bounds check. Awareness updates
 * (cursor moves) and Y.Text content updates (edits) are two independent,
 * unsynchronized event streams — during rapid back-and-forth editing, a
 * remote cursor-move awareness event can arrive and get rendered before the
 * corresponding content change has been dispatched into *this* view's CM6
 * document, so the computed position is briefly out of range. `lineAt()`
 * then throws — and per @codemirror/view's own PluginInstance.update(), a
 * thrown update() gets the plugin destroyed and permanently deactivated for
 * the rest of that view's lifetime (confirmed by reading its source): every
 * other remote cursor/highlight vanishes until the note is closed and
 * reopened or the plugin reloaded, exactly matching the reported bug.
 *
 * Fix: bounds-check every remote position against this view's *current*
 * document length before touching it, and skip (don't crash) on a mismatch
 * — it self-corrects on the next update once content catches up. Also wraps
 * each remote peer's decoration work individually so one bad state can't
 * take the rest of the room's cursors down with it.
 *
 * That "self-corrects on the next update" only holds if something actually
 * triggers a next update. If the remote peer then holds a *static* selection
 * (stops moving their cursor, makes no more edits), nothing else fires a
 * recompute and the skip becomes effectively permanent — confirmed live:
 * a genuine, valid remote selection made right after a burst of edits
 * rendered on one side but never appeared on the other, and stayed that way
 * indefinitely. Fix: when a skip happens, proactively schedule a short
 * follow-up recompute (not just wait for the next natural trigger), with a
 * capped retry budget so a truly orphaned state doesn't retry forever.
 */

class YRemoteCaretWidget extends WidgetType {
  constructor(
    private color: string,
    private name: string
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-ySelectionCaret";
    wrap.style.backgroundColor = this.color;
    wrap.style.borderColor = this.color;
    wrap.appendChild(document.createTextNode("⁠"));
    const dot = wrap.appendChild(document.createElement("div"));
    dot.className = "cm-ySelectionCaretDot";
    wrap.appendChild(document.createTextNode("⁠"));
    const info = wrap.appendChild(document.createElement("div"));
    info.className = "cm-ySelectionInfo";
    info.textContent = this.name;
    wrap.appendChild(document.createTextNode("⁠"));
    return wrap;
  }

  eq(widget: YRemoteCaretWidget): boolean {
    return widget.color === this.color && widget.name === this.name;
  }

  get estimatedHeight(): number {
    return -1;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const remoteSelectionsAnnotation = Annotation.define<number[]>();

const RETRY_DELAY_MS = 100;
const MAX_RETRY_ATTEMPTS = 10; // ~1s total — long enough for a lagging sync to catch up, bounded so a truly stuck state doesn't retry forever

class HardenedRemoteSelectionsPluginValue implements PluginValue {
  decorations: DecorationSet = Decoration.none;
  private conf: YSyncConfig;
  private awareness: any;
  private listener: (update: { added: number[]; updated: number[]; removed: number[] }) => void;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;

  constructor(view: EditorView) {
    this.conf = view.state.facet(ySyncFacet);
    this.awareness = this.conf.awareness;
    this.listener = ({ added, updated, removed }) => {
      const clients = added.concat(updated).concat(removed);
      if (clients.some((id) => id !== this.awareness.doc.clientID)) {
        view.dispatch({ annotations: [remoteSelectionsAnnotation.of([])] });
      }
    };
    this.awareness.on("change", this.listener);
  }

  destroy(): void {
    this.awareness.off("change", this.listener);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /**
   * A skip only self-corrects if something triggers another update() call.
   * If the remote peer then goes static (no more edits/cursor moves), the
   * natural awareness-change listener never fires again — so proactively
   * force one shortly after, instead of waiting indefinitely for a trigger
   * that may never come.
   */
  private scheduleRetry(view: EditorView): void {
    if (this.retryTimer || this.retryAttempts >= MAX_RETRY_ATTEMPTS) return;
    this.retryAttempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      view.dispatch({ annotations: [remoteSelectionsAnnotation.of([])] });
    }, RETRY_DELAY_MS);
  }

  update(update: ViewUpdate): void {
    const ytext = this.conf.ytext;
    const ydoc = ytext.doc;
    const awareness = this.conf.awareness;
    const decorations: any[] = [];
    const localAwarenessState = awareness.getLocalState();

    if (localAwarenessState != null) {
      const hasFocus = update.view.hasFocus && update.view.dom.ownerDocument.hasFocus();
      const sel = hasFocus ? update.state.selection.main : null;
      const currentAnchor =
        localAwarenessState.cursor == null ? null : Y.createRelativePositionFromJSON(localAwarenessState.cursor.anchor);
      const currentHead =
        localAwarenessState.cursor == null ? null : Y.createRelativePositionFromJSON(localAwarenessState.cursor.head);

      if (sel != null) {
        const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
        const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
        if (
          localAwarenessState.cursor == null ||
          !Y.compareRelativePositions(currentAnchor, anchor) ||
          !Y.compareRelativePositions(currentHead, head)
        ) {
          awareness.setLocalStateField("cursor", { anchor, head });
        }
      } else if (localAwarenessState.cursor != null && hasFocus) {
        awareness.setLocalStateField("cursor", null);
      }
    }

    const docLength = update.view.state.doc.length;
    let sawStalePosition = false;

    awareness.getStates().forEach((state: any, clientId: number) => {
      if (clientId === awareness.doc.clientID) return;
      try {
        const cursor = state.cursor;
        if (cursor == null || cursor.anchor == null || cursor.head == null) return;
        const anchor = Y.createAbsolutePositionFromRelativePosition(cursor.anchor, ydoc);
        const head = Y.createAbsolutePositionFromRelativePosition(cursor.head, ydoc);
        if (anchor == null || head == null || anchor.type !== ytext || head.type !== ytext) {
          sawStalePosition = true;
          return;
        }

        const start = Math.min(anchor.index, head.index);
        const end = Math.max(anchor.index, head.index);

        // The critical guard: skip instead of crashing when this remote
        // position hasn't been reconciled with this view's document yet —
        // see the file header for why this happens and what it fixes.
        if (start < 0 || end > docLength) {
          sawStalePosition = true;
          return;
        }

        const { color = "#30bced", name = "Anonymous" } = state.user || {};
        const colorLight = (state.user && state.user.colorLight) || color + "33";
        const startLine = update.view.state.doc.lineAt(start);
        const endLine = update.view.state.doc.lineAt(end);

        if (startLine.number === endLine.number) {
          decorations.push({
            from: start,
            to: end,
            value: Decoration.mark({ attributes: { style: `background-color: ${colorLight}` }, class: "cm-ySelection" }),
          });
        } else {
          decorations.push({
            from: start,
            to: startLine.from + startLine.length,
            value: Decoration.mark({ attributes: { style: `background-color: ${colorLight}` }, class: "cm-ySelection" }),
          });
          decorations.push({
            from: endLine.from,
            to: end,
            value: Decoration.mark({ attributes: { style: `background-color: ${colorLight}` }, class: "cm-ySelection" }),
          });
          for (let i = startLine.number + 1; i < endLine.number; i++) {
            const linePos = update.view.state.doc.line(i).from;
            decorations.push({
              from: linePos,
              to: linePos,
              value: Decoration.line({ attributes: { style: `background-color: ${colorLight}`, class: "cm-yLineSelection" } }),
            });
          }
        }

        decorations.push({
          from: head.index,
          to: head.index,
          value: Decoration.widget({
            side: head.index - anchor.index > 0 ? -1 : 1,
            block: false,
            widget: new YRemoteCaretWidget(color, name),
          }),
        });
      } catch (err) {
        // Never let one bad remote state take down rendering for everyone
        // else in the room — log and move on.
        console.warn("[multiplayer-markdown] skipped a remote cursor decoration", err);
        sawStalePosition = true;
      }
    });

    this.decorations = Decoration.set(decorations, true);

    if (sawStalePosition) {
      this.scheduleRetry(update.view);
    } else {
      this.retryAttempts = 0;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    }
  }
}

/** Use in place of y-codemirror.next's own `yRemoteSelections` export — same visuals/CSS classes, hardened update(). */
export const hardenedRemoteSelections = ViewPlugin.fromClass(HardenedRemoteSelectionsPluginValue, {
  decorations: (v) => v.decorations,
});
