// 通用按鈕。variant 控制樣式，其餘 props（onClick、disabled、type...）透傳。
function Button({
  children,
  variant = 'primary', // primary | ghost | danger | subtle
  size = 'md', // sm | md
  className = '',
  ...rest
}) {
  return (
    <button
      className={`btn btn--${variant} btn--${size} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export default Button
