export default function Card({ title, description, actions, children, className = "" }) {
  return <section className={`card-panel enter-card ${className}`}>
    {(title || description || actions) && <div className="card-heading"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{actions}</div>}
    {children}
  </section>;
}
