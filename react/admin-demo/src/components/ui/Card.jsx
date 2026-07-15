// 卡片容器。可選 title / actions（右上角）。
function Card({ title, actions, className = '', children }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card__head">
          {title && <h3 className="card__title">{title}</h3>}
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  )
}

export default Card
