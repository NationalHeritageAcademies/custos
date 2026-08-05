import { Component, inject } from '@angular/core';
import { CustosClient } from './custos-client.service';
import { ThemeService } from './theme.service';

/**
 * Root component. Currently renders the faithful Main Window from the Claude
 * Design handoff (screen 1c/1d), themed entirely through the design tokens so
 * light/dark are correct from the start. The theme toggle is live via
 * {@link ThemeService}; {@link CustosClient} is wired and ready to replace the
 * representative content with live driver/connection/query data.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  readonly theme = inject(ThemeService);
  readonly client = inject(CustosClient);
}
