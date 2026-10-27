export default function Skeleton({ kind = "chart" }) {
  return <div className={`skeleton skeleton-${kind}`} aria-label="Loading data" role="status"><span /><span /><span /></div>;
}
