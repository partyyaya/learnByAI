import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { api } from "../api/client";
import { IconMegaphone } from "./icons";

/**
 * 導航欄的跑馬燈。
 *
 * 無縫循環的做法是「把同一份清單印兩次，然後把整條軌道平移 -50%」：
 * 動畫跑完的那一刻，第二份剛好移到第一份原本的位置，畫面上看不出接縫。
 * 只印一份的話，跑到尾端會出現一段空白再跳回開頭。
 *
 * 第二份純粹是視覺用的，所以掛 aria-hidden，讀螢幕的人不會聽到兩次。
 */
export function Marquee() {
  const { data, loading, error } = useApi(() => api.get("/announcements"), []);
  const items = data?.items ?? [];

  // 速度跟著文字長度算，不然公告一多就會變成飛快閃過。
  // 大約每秒 7 個字，最少跑 32 秒。
  const duration = useMemo(() => {
    const characters = items.reduce((sum, item) => sum + item.text.length, 0);
    return Math.max(32, Math.round(characters / 7));
  }, [items]);

  if (loading) return <div className="marquee marquee--idle">載入公告中…</div>;

  // 公告載不到不是什麼嚴重的事，安靜地退回一句話就好，不要跳錯誤視窗
  if (error || items.length === 0) {
    return <div className="marquee marquee--idle">目前沒有系統公告</div>;
  }

  return (
    <div className="marquee">
      <span className="marquee__icon" title="系統公告">
        <IconMegaphone size={16} />
      </span>

      <div className="marquee__viewport">
        <div className="marquee__track" style={{ animationDuration: `${duration}s` }}>
          {[0, 1].map((copy) => (
            <div className="marquee__group" key={copy} aria-hidden={copy === 1 ? "true" : undefined}>
              {items.map((item) => (
                <span key={item.id} className="marquee__item">
                  <i className={`marquee__dot marquee__dot--${item.level}`} />
                  {item.text}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
