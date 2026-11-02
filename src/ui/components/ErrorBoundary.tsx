// Error boundary: if a UI component crashes while rendering, show a message for that part instead of a blank page.
// React only supports this as a class component (componentDidCatch / getDerivedStateFromError).
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  // Which part of the screen this protects, shown in the message.
  area: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Real product: report to monitoring (e.g. Sentry). Here: the console.
    console.error(`UI error in ${this.props.area}`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="banner banner-error" role="alert">
          Something went wrong in {this.props.area}. The rest of the dashboard keeps working.{' '}
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
