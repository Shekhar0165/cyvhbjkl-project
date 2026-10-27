export default function Tabs({ items, value, onChange, label }) {
  const activateByOffset = (event) => {
    const keyIndex = items.findIndex((item) => item.id === value);
    let next = keyIndex;
    if (event.key === "ArrowRight") next = (keyIndex + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (keyIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    onChange(items[next].id);
    requestAnimationFrame(() => document.getElementById(`tab-${items[next].id}`)?.focus());
  };
  return <div className="segmented-tabs" role="tablist" aria-label={label} onKeyDown={activateByOffset}>
    {items.map((item) => <button key={item.id} id={`tab-${item.id}`} type="button" role="tab" aria-selected={value === item.id} aria-controls={`panel-${item.id}`} tabIndex={value === item.id ? 0 : -1} className={value === item.id ? "selected" : ""} onClick={() => onChange(item.id)}>{item.label}</button>)}
  </div>;
}
