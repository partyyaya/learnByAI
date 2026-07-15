// 頁面標題列：標題 + 說明（通常標註對應課程章節）+ 右側操作區。
function PageHeader({ title, subtitle, chapter, actions }) {
  return (
    <div className="page-header">
      <div>
        <div className="page-header__titlerow">
          <h1 className="page-header__title">{title}</h1>
          {chapter && <span className="page-header__chapter">{chapter}</span>}
        </div>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  )
}

export default PageHeader
