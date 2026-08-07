import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, effect, inject } from '@angular/core';
import type * as Monaco from 'monaco-editor';
import { WorkspaceStore } from '../state/workspace.store';
import { ThemeService } from '../theme.service';

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'ON', 'GROUP BY',
  'ORDER BY', 'HAVING', 'LIMIT', 'TOP', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE VIEW', 'AS', 'AND', 'OR',
  'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'BETWEEN', 'DISTINCT', 'COUNT', 'SUM',
  'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'UNION ALL', 'WITH',
  'DESC', 'ASC', 'CAST', 'COALESCE', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
];

let providerRegistered = false;
let themesDefined = false;

// Monaco needs a worker factory; we don't use worker-backed features (our
// completion provider runs on the main thread), so a blank worker satisfies it.
function ensureMonacoEnvironment(): void {
  const g = self as unknown as { MonacoEnvironment?: unknown };
  if (!g.MonacoEnvironment) {
    g.MonacoEnvironment = {
      getWorker: () => new Worker(URL.createObjectURL(new Blob([''], { type: 'application/javascript' }))),
    };
  }
}

/**
 * The SQL editor, backed by Monaco: syntax highlighting, our light/dark themes
 * (from the design tokens), schema-aware autocomplete (loaded table names +
 * keywords), and the run keybindings. Bound to the active tab's SQL.
 */
@Component({
  selector: 'app-code-editor',
  standalone: true,
  template: `<div class="host" #host></div>`,
  styles: [`
    :host { height: 222px; flex: none; display: block; border-bottom: 1px solid var(--border); background: var(--bg); }
    .host { height: 100%; width: 100%; }
  `],
})
export class CodeEditorComponent implements AfterViewInit, OnDestroy {
  @ViewChild('host', { static: true }) private hostRef!: ElementRef<HTMLDivElement>;
  private readonly ws = inject(WorkspaceStore);
  private readonly theme = inject(ThemeService);
  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private monaco?: typeof Monaco;
  private applyingExternal = false;
  private readonly onResize = () => this.editor?.layout();

  constructor() {
    // Push external SQL changes (tab switch, table click, history reopen) in.
    effect(() => {
      const sql = this.ws.sql();
      if (this.editor && this.editor.getValue() !== sql) {
        this.applyingExternal = true;
        this.editor.setValue(sql);
        this.applyingExternal = false;
      }
    });
    // Keep Monaco's theme in sync with the app theme.
    effect(() => {
      this.theme.mode();
      this.monaco?.editor.setTheme(this.themeName());
    });
  }

  async ngAfterViewInit(): Promise<void> {
    ensureMonacoEnvironment();
    const monaco = await import('monaco-editor');
    this.monaco = monaco;
    this.defineThemes(monaco);
    this.registerCompletions(monaco);

    this.editor = monaco.editor.create(this.hostRef.nativeElement, {
      value: this.ws.sql(),
      language: 'sql',
      theme: this.themeName(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12.5,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      wordBasedSuggestions: 'off',
      padding: { top: 8 },
    });

    this.editor.onDidChangeModelContent(() => {
      if (!this.applyingExternal) this.ws.setSql(this.editor!.getValue());
    });
    this.editor.onDidChangeCursorSelection(() => {
      const sel = this.editor!.getSelection();
      this.ws.selectionText.set(sel ? this.editor!.getModel()!.getValueInRange(sel) : '');
      const pos = this.editor!.getPosition();
      if (pos) this.ws.cursor.set({ line: pos.lineNumber, column: pos.column });
    });

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void this.ws.run());
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      () => void this.ws.runSelection(),
    );

    window.addEventListener('resize', this.onResize);
  }

  private themeName(): string {
    return this.theme.resolved === 'dark' ? 'custos-dark' : 'custos-light';
  }

  private defineThemes(monaco: typeof Monaco): void {
    if (themesDefined) return;
    themesDefined = true;
    monaco.editor.defineTheme('custos-light', {
      base: 'vs', inherit: true,
      rules: [
        { token: 'keyword', foreground: '12626F', fontStyle: 'bold' },
        { token: 'string', foreground: '8A5300' },
        { token: 'number', foreground: '1D5FA8' },
        { token: 'comment', foreground: '8695A0', fontStyle: 'italic' },
        { token: 'predefined', foreground: '6B3FA0' },
        { token: 'operator', foreground: '54626C' },
      ],
      colors: { 'editor.background': '#FFFFFF', 'editor.foreground': '#101619', 'editorLineNumber.foreground': '#8695A0', 'editor.selectionBackground': '#E4F1F0', 'editor.lineHighlightBackground': '#F7F8FA' },
    });
    monaco.editor.defineTheme('custos-dark', {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'keyword', foreground: '5FD3C9', fontStyle: 'bold' },
        { token: 'string', foreground: 'E0B571' },
        { token: 'number', foreground: '8AB6F0' },
        { token: 'comment', foreground: '6D7D86', fontStyle: 'italic' },
        { token: 'predefined', foreground: 'C4A6F0' },
        { token: 'operator', foreground: '9EABB3' },
      ],
      colors: { 'editor.background': '#0E1417', 'editor.foreground': '#E7EEF1', 'editorLineNumber.foreground': '#6D7D86', 'editor.selectionBackground': '#10312F', 'editor.lineHighlightBackground': '#141B20' },
    });
  }

  private registerCompletions(monaco: typeof Monaco): void {
    if (providerRegistered) return;
    providerRegistered = true;
    const ws = this.ws;
    monaco.languages.registerCompletionItemProvider('sql', {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
          startColumn: word.startColumn, endColumn: word.endColumn,
        };
        const suggestions: Monaco.languages.CompletionItem[] = [
          ...SQL_KEYWORDS.map((k) => ({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range })),
          ...ws.tableNames().map((t) => ({ label: t, kind: monaco.languages.CompletionItemKind.Struct, insertText: t, detail: 'table', range })),
        ];
        return { suggestions };
      },
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.editor?.dispose();
  }
}
