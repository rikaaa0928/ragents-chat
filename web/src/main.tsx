import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-8 max-w-xl mx-auto mt-12 rounded-2xl border border-red-500/40 bg-red-500/10 text-sm space-y-3">
          <div className="font-semibold text-red-500">
            界面渲染异常: {this.state.error.message}
          </div>
          <pre className="text-xs font-mono-code overflow-auto p-3 rounded bg-black/20">
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium cursor-pointer"
          >
            刷新恢复
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
