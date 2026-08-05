import { Component, computed, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/**
 * The SQL editor region. A monospace textarea bound to
 * {@link WorkspaceStore.sql} with a line-number gutter. Cmd/Ctrl+Enter runs.
 * Syntax highlighting and autocomplete arrive with Monaco (execution plan
 * Phase 6); this keeps the editor genuinely editable and runnable today.
 */
@Component({
  selector: 'app-editor-pane',
  standalone: true,
  template: `
    <div class="editor">
      <div class="gutter">
        @for (n of lines(); track n) {
          <div>{{ n }}</div>
        }
      </div>
      <textarea
        class="code selectable"
        spellcheck="false"
        [value]="ws.sql()"
        (input)="onInput($event)"
        (keydown)="onKeydown($event)"
      ></textarea>
    </div>
  `,
  styles: [`
    .editor { height: 222px; flex: none; display: flex; background: var(--bg); border-bottom: 1px solid var(--border); overflow: hidden; }
    .gutter { flex: none; padding: 10px 10px 10px 0; text-align: right; font: 400 12.5px/1.85 var(--font-mono); color: var(--text-3); background: var(--bg); border-right: 1px solid var(--border); user-select: none; }
    .code { flex: 1; border: 0; outline: none; resize: none; padding: 10px 0 10px 14px; background: var(--bg); color: var(--text); font: 400 12.5px/1.85 var(--font-mono); white-space: pre; }
  `],
})
export class EditorPaneComponent {
  readonly ws = inject(WorkspaceStore);

  readonly lines = computed(() => {
    const count = Math.max(this.ws.sql().split('\n').length, 1);
    return Array.from({ length: count }, (_, i) => i + 1);
  });

  onInput(event: Event): void {
    this.ws.sql.set((event.target as HTMLTextAreaElement).value);
  }

  onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.ws.run();
    }
  }
}
