import { Component, ComponentChildren } from 'preact';
import { handleError, ErrorCodes } from '../lib/errors';

interface Props {
  children: ComponentChildren;
  fallback?: ComponentChildren;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, _errorInfo: unknown) {
    // Use centralized error handling for React boundary errors
    handleError(error, 'react.errorBoundary', ErrorCodes.INITIALIZATION_FAILED);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div class="error-boundary">
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message}</p>
          <button onClick={() => this.setState({ hasError: false, error: null })}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
