import { Component, OnInit, inject } from '@angular/core';
import { ConnectionFormComponent } from './components/connection-form.component';
import { ConnectionTreeComponent } from './components/connection-tree.component';
import { ContextBarComponent } from './components/context-bar.component';
import { ImportDialogComponent } from './components/import-dialog.component';
import { EditorPaneComponent } from './components/editor-pane.component';
import { EditorTabsComponent } from './components/editor-tabs.component';
import { EditorToolbarComponent } from './components/editor-toolbar.component';
import { HistoryPanelComponent } from './components/history-panel.component';
import { ResultsBarComponent } from './components/results-bar.component';
import { ResultsGridComponent } from './components/results-grid.component';
import { SafetyDialogComponent } from './components/safety-dialog.component';
import { WelcomeComponent } from './components/welcome.component';
import { CustosClient } from './custos-client.service';
import { ThemeService } from './theme.service';
import { WorkspaceStore } from './state/workspace.store';

/**
 * Root component. Renders the Main Window from the Claude Design handoff (1c/1d),
 * now data-driven: the connection tree, editor, and results grid are live
 * components backed by {@link WorkspaceStore}. Theming is live via
 * {@link ThemeService}; the backend is the real Electron bridge when present, or
 * an in-browser demo otherwise (so the full loop is exercisable during design).
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    ConnectionTreeComponent,
    ContextBarComponent,
    EditorTabsComponent,
    EditorToolbarComponent,
    EditorPaneComponent,
    ResultsBarComponent,
    ResultsGridComponent,
    SafetyDialogComponent,
    ConnectionFormComponent,
    ImportDialogComponent,
    HistoryPanelComponent,
    WelcomeComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  readonly theme = inject(ThemeService);
  readonly client = inject(CustosClient);
  readonly ws = inject(WorkspaceStore);

  ngOnInit(): void {
    void this.ws.init();
  }
}
