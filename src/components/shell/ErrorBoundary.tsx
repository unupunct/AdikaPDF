import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logCrash, logsFolder, openLogsFolder } from '@/lib/log';

interface State {
  error: Error | null;
  reportPath: string | null;
}

/** Last-resort crash screen: keeps the window usable and offers a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, reportPath: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, reportPath: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Adika crashed', error, info.componentStack);
    (window as unknown as { __adikaLastCrash?: unknown }).__adikaLastCrash = { message: error.message, stack: error.stack, componentStack: info.componentStack };
    void logCrash('user interface', `${error.name}: ${error.message}

Stack:
${error.stack ?? '(none)'}

Components:${info.componentStack ?? ''}`).then((reportPath) =>
      this.setState({ reportPath: reportPath ?? null }),
    );
    void logsFolder();
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-app p-8 text-center">
        <img src="./brand/adika-icon.svg" alt="" className="h-12 w-12" />
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted">{this.state.error.message}</p>
        {this.state.reportPath ? (
          <p className="max-w-md text-xs text-muted">
            A crash report was saved to <span className="font-mono">{this.state.reportPath}</span>
          </p>
        ) : null}
        {this.state.reportPath ? (
          <button type="button" className="text-sm text-brand-600 underline" onClick={() => void openLogsFolder()}>
            Open logs folder
          </button>
        ) : null}
        <button type="button" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white" onClick={() => location.reload()}>
          Reload Adika
        </button>
      </div>
    );
  }
}
