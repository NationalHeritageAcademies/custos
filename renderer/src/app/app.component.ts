import { Component, OnInit, inject } from '@angular/core';
import { ConnectionTreeComponent } from './components/connection-tree.component';
import { EditorPaneComponent } from './components/editor-pane.component';
import { ResultsGridComponent } from './components/results-grid.component';
import { SafetyDialogComponent } from './components/safety-dialog.component';
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
    EditorPaneComponent,
    ResultsGridComponent,
    SafetyDialogComponent,
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
