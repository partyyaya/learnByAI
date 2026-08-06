// 手寫的 SVG 圖示，沒有外部套件也沒有 icon font。
//
// 兩個共同的設定讓它們看起來像一套：stroke="currentColor"（顏色跟著文字，深淺色
// 主題都不用改）與 strokeWidth 1.7（跟介面的字重相稱）。

function Icon({ size = 18, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (props) => (
  <Icon {...props}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="4.5" rx="1.5" />
    <rect x="13.5" y="10.5" width="7.5" height="10.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </Icon>
);

export const IconUsers = (props) => (
  <Icon {...props}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20.5c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
    <path d="M16.5 5.2a3.5 3.5 0 0 1 0 6.6" />
    <path d="M18.5 14.9c2 .8 3.2 2.5 3.2 5.6" />
  </Icon>
);

export const IconOrders = (props) => (
  <Icon {...props}>
    <path d="M5 3.5h11.5L20 8v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20V5a1.5 1.5 0 0 1 1-1.5Z" />
    <path d="M15.5 3.5V8H20" />
    <path d="M8 12.5h7M8 16.5h4.5" />
  </Icon>
);

export const IconSettings = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a1.6 1.6 0 1 1-2.3 2.3l-.1-.1a1.7 1.7 0 0 0-2.8 1.2v.3a1.6 1.6 0 1 1-3.2 0V20a1.7 1.7 0 0 0-2.8-1.2l-.1.1a1.6 1.6 0 1 1-2.3-2.3l.1-.1A1.7 1.7 0 0 0 4 15a1.6 1.6 0 0 1-1.6-1.6 1.6 1.6 0 0 1 1.6-1.6 1.7 1.7 0 0 0 1.2-2.8l-.1-.1a1.6 1.6 0 1 1 2.3-2.3l.1.1A1.7 1.7 0 0 0 10.3 4.6h.1A1.6 1.6 0 0 1 12 3a1.6 1.6 0 0 1 1.6 1.6v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a1.6 1.6 0 1 1 2.3 2.3l-.1.1a1.7 1.7 0 0 0 1.2 2.8h.3a1.6 1.6 0 1 1 0 3.2h-.3a1.7 1.7 0 0 0-1.5 1Z" />
  </Icon>
);

export const IconLogout = (props) => (
  <Icon {...props}>
    <path d="M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15" />
    <path d="M10.5 8 6.5 12l4 4" />
    <path d="M6.5 12H15" />
  </Icon>
);

export const IconChevronDown = (props) => (
  <Icon {...props}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const IconChevronLeft = (props) => (
  <Icon {...props}>
    <path d="m14.5 6-6 6 6 6" />
  </Icon>
);

export const IconChevronRight = (props) => (
  <Icon {...props}>
    <path d="m9.5 6 6 6-6 6" />
  </Icon>
);

export const IconSearch = (props) => (
  <Icon {...props}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 4.5 4.5" />
  </Icon>
);

export const IconSidebar = (props) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9.5 4v16" />
  </Icon>
);

export const IconMegaphone = (props) => (
  <Icon {...props}>
    <path d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5h1.8L14 19.5V4.5L7.3 9H5.5A1.5 1.5 0 0 0 4 10.5Z" />
    <path d="M17.5 9a4 4 0 0 1 0 6" />
    <path d="M7.3 15v4a1.5 1.5 0 0 0 3 0v-2.5" />
  </Icon>
);

export const IconRefresh = (props) => (
  <Icon {...props}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v4.5h-4.5" />
  </Icon>
);

export const IconTrash = (props) => (
  <Icon {...props}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V4.8A.8.8 0 0 1 10.3 4h3.4a.8.8 0 0 1 .8.8V7" />
    <path d="M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7" />
    <path d="M10.5 11v6M13.5 11v6" />
  </Icon>
);

export const IconSun = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
  </Icon>
);

export const IconMoon = (props) => (
  <Icon {...props}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Icon>
);

export const IconUser = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="8" r="3.8" />
    <path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5" />
  </Icon>
);

export const IconLock = (props) => (
  <Icon {...props}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    <path d="M12 14.5v2" />
  </Icon>
);

export const IconAlert = (props) => (
  <Icon {...props}>
    <path d="M12 3.8 21 19.5H3L12 3.8Z" />
    <path d="M12 9.5v4.5M12 17h.01" />
  </Icon>
);

export const IconInbox = (props) => (
  <Icon {...props}>
    <path d="M3.5 13.5 6 5.5h12l2.5 8" />
    <path d="M3.5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-5.5h-5a3 3 0 0 1-6 0h-6Z" />
  </Icon>
);

export const IconCheck = (props) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const IconPower = (props) => (
  <Icon {...props}>
    <path d="M12 3.5v7" />
    <path d="M6.8 7.2a7.5 7.5 0 1 0 10.4 0" />
  </Icon>
);
