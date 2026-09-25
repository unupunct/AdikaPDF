import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** Last-resort crash screen: keeps the window usable and offers a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Adika crashed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-app p-8 text-center">
        <img src="./brand/adika-icon.svg" alt="" className="h-12 w-12" />
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted">{this.state.error.message}</p>
        <button type="button" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white" onClick={() => location.reload()}>
          Reload Adika
        </button>
      </div>
    );
  }
}
