import React from "react";
import * as ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./style.css";

class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("WindDesk render error", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <main role="alert" className="render-error-shell">
          <section className="render-error-card">
            <h1>WindDesk could not render</h1>
            <p>The page hit an unexpected error. Reload the page or contact support.</p>
            <pre>{this.state.error.message}</pre>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error('Required mount element "#root" was not found in index.html.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
