# 第 6 章：表單處理與驗證

## 本章目標

完成這一章後，你應該可以：

1. 使用受控元件（Controlled Components）管理表單欄位。
2. 撰寫同步驗證規則（必填、長度、範圍）。
3. 在提交失敗時正確顯示錯誤訊息。
4. 在提交成功後清空表單並更新畫面資料。

---

## 1. 受控元件（Controlled Components）

React 表單推薦模式：

- 欄位值由 state 控制
- `onChange` 即時同步 state
- 提交時統一驗證

```jsx
const [name, setName] = useState("");
<input value={name} onChange={(e) => setName(e.target.value)} />;
```

---

## 2. 表單資料建議用物件管理

欄位多時，通常會用單一 `form` 物件：

```jsx
const [form, setForm] = useState({
  title: "",
  level: "beginner",
  minutes: "",
});
```

更新時保留其他欄位：

```jsx
setForm((prev) => ({ ...prev, title: e.target.value }));
```

---

## 3. 驗證策略

建議先做「同步驗證」：

- `title` 必填，至少 4 個字
- `minutes` 必填，且在合理範圍
- `level` 必須是預設選項之一

驗證函式應回傳錯誤物件：

```js
{
  title: "標題至少 4 個字",
  minutes: "時長需介於 5 到 180"
}
```

---

## 4. 顯示錯誤訊息的時機

常見做法：

1. `onSubmit` 時全欄位驗證（必要）
2. `onBlur` 時單欄位驗證（提升體驗）
3. `onChange` 即時清除已修正欄位的錯誤

---

## 5. 本章小練習

1. 建一個「新增課程」表單：標題、等級、時長、描述。
2. 標題與時長必填，描述至少 10 字。
3. 驗證失敗時顯示紅字錯誤。
4. 提交成功後，列表新增課程卡片。

---

## 最後範例：課程建立表單（含驗證）

### `src/App.jsx`

```jsx
import { useState } from "react";
import "./App.css";

const levelOptions = ["beginner", "intermediate", "advanced"];

function validateForm(form) {
  const errors = {};

  if (!form.title.trim()) {
    errors.title = "課程名稱為必填。";
  } else if (form.title.trim().length < 4) {
    errors.title = "課程名稱至少 4 個字。";
  }

  const minutes = Number(form.minutes);
  if (!form.minutes) {
    errors.minutes = "課程時長為必填。";
  } else if (Number.isNaN(minutes) || minutes < 5 || minutes > 180) {
    errors.minutes = "課程時長需介於 5 到 180 分鐘。";
  }

  if (!levelOptions.includes(form.level)) {
    errors.level = "請選擇有效的課程等級。";
  }

  if (!form.description.trim()) {
    errors.description = "課程描述為必填。";
  } else if (form.description.trim().length < 10) {
    errors.description = "課程描述至少 10 個字。";
  }

  return errors;
}

const initialForm = {
  title: "",
  level: "beginner",
  minutes: "",
  description: "",
};

function App() {
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [courses, setCourses] = useState([]);

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function handleSubmit(event) {
    event.preventDefault();

    const validationErrors = validateForm(form);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) return;

    const newCourse = {
      id: crypto.randomUUID(),
      ...form,
      minutes: Number(form.minutes),
    };

    setCourses((prev) => [newCourse, ...prev]);
    setForm(initialForm);
    setErrors({});
  }

  return (
    <main className="page">
      <h1>第 6 章最終範例：表單處理與驗證</h1>

      <section className="card">
        <h2>新增課程</h2>

        <form onSubmit={handleSubmit} noValidate>
          <label>
            課程名稱
            <input
              value={form.title}
              onChange={(e) => updateField("title", e.target.value)}
              placeholder="例如：React Router 實戰"
            />
            {errors.title && <small className="error">{errors.title}</small>}
          </label>

          <label>
            課程等級
            <select
              value={form.level}
              onChange={(e) => updateField("level", e.target.value)}
            >
              <option value="beginner">beginner</option>
              <option value="intermediate">intermediate</option>
              <option value="advanced">advanced</option>
            </select>
            {errors.level && <small className="error">{errors.level}</small>}
          </label>

          <label>
            課程時長（分鐘）
            <input
              type="number"
              value={form.minutes}
              onChange={(e) => updateField("minutes", e.target.value)}
              placeholder="5 ~ 180"
            />
            {errors.minutes && <small className="error">{errors.minutes}</small>}
          </label>

          <label>
            課程描述
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="請描述本章節會學到什麼"
            />
            {errors.description && (
              <small className="error">{errors.description}</small>
            )}
          </label>

          <button type="submit">建立課程</button>
        </form>
      </section>

      <section className="card">
        <h2>已建立課程（{courses.length}）</h2>
        {courses.length === 0 ? (
          <p>目前沒有課程，請先新增一筆。</p>
        ) : (
          <ul className="course-list">
            {courses.map((course) => (
              <li key={course.id}>
                <strong>{course.title}</strong> - {course.level} - {course.minutes} 分鐘
                <p>{course.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export default App;
```

### `src/App.css`

```css
body {
  margin: 0;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f8fafc;
}

.page {
  width: min(820px, 100%);
  margin: 28px auto;
  padding: 0 16px 30px;
}

.card {
  background: #ffffff;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 14px;
  box-shadow: 0 6px 18px rgba(17, 24, 39, 0.06);
}

form {
  display: grid;
  gap: 12px;
}

label {
  display: grid;
  gap: 6px;
  font-weight: 600;
}

input,
select,
textarea {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

button {
  width: fit-content;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #ffffff;
  padding: 8px 14px;
  cursor: pointer;
}

.error {
  color: #b91c1c;
  font-weight: 500;
}

.course-list {
  padding-left: 18px;
}

.course-list li {
  margin-bottom: 10px;
}

.course-list p {
  margin: 6px 0 0;
  color: #334155;
}
```

### 範例解釋

1. 每個表單欄位都綁定到 `form` state，這就是受控元件模式。
2. `validateForm` 回傳錯誤物件，`handleSubmit` 依錯誤數量決定是否提交。
3. `updateField` 同步更新欄位並清除該欄位舊錯誤，讓修正體驗更即時。
4. 通過驗證後，才把資料加入 `courses` 清單，並重設表單狀態。

---

## 本章結語

你已經能完成完整的表單流程（輸入、驗證、提交、回饋）。  
下一章會進入副作用 `useEffect`，正式處理 API 資料抓取。
