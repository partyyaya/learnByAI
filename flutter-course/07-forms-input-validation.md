# 第 07 章：表單、輸入與驗證

> 幾乎每個 App 都有表單：登入、註冊、搜尋、新增資料。這一章把「使用者輸入」這條線打通：
> 從最基本的 `TextField`、如何取得輸入值、用 `Form` 做整批驗證，到鍵盤與焦點管理，最後把表單接上 Riverpod。
> 重點觀念：**Flutter 的輸入框跟你的資料是「兩回事」，你要決定誰是源頭。**

---

## 7.1 TextField：最基本的輸入框，與「怎麼拿到值」

```dart
TextField(
  decoration: const InputDecoration(
    labelText: '姓名',
    hintText: '請輸入你的名字',
    border: OutlineInputBorder(),
  ),
  onChanged: (value) {
    print('現在輸入：$value');     // 每打一個字就觸發一次
  },
)
```

逐段解釋：

- **`TextField`**：純輸入框。`decoration` 控制外觀（label、提示字、邊框、icon）。
- **`InputDecoration`**：輸入框的「裝飾說明書」。`labelText`（會浮動的標籤）、`hintText`（灰色提示）、`border`（邊框樣式）。
- **`onChanged`**：使用者每改一次內容就呼叫，把最新文字 `value` 給你。**這是取得輸入值的方式之一。**

但 `onChanged` 有個限制：它只在「使用者打字」時給你值。如果你想**主動讀取/設定**輸入框內容（例如送出前讀全部、或預填一個值），要用 **controller**。

### TextEditingController：主動掌控輸入框

```dart
class NameInput extends StatefulWidget {
  const NameInput({super.key});
  @override
  State<NameInput> createState() => _NameInputState();
}

class _NameInputState extends State<NameInput> {
  // 1) 建立 controller
  final _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _controller.text = '預設名字';        // 可以預填內容
  }

  @override
  void dispose() {
    _controller.dispose();               // ⭐ 一定要釋放，否則記憶體洩漏
    super.dispose();
  }

  void _submit() {
    print('送出：${_controller.text}');   // 主動讀取目前值
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        TextField(controller: _controller),    // 2) 綁定 controller
        ElevatedButton(onPressed: _submit, child: const Text('送出')),
      ],
    );
  }
}
```

逐段解釋（**這裡用上了第 03 章的生命週期觀念**）：

- **`TextEditingController`**：一個「掌控輸入框內容」的物件。透過它你可以隨時 `.text` 讀值、設值、清空。
- **`controller: _controller`**：把 controller 綁到 TextField。綁了之後，輸入框內容跟 controller 同步。
- **`initState` 裡 `_controller.text = ...`**：預填初始值（編輯既有資料的表單常用）。
- **`dispose` 裡 `_controller.dispose()`**：**極重要**！controller 是「會佔資源、持續存在」的物件，第 03 章說過「開了就要在 dispose 關」。**忘記 dispose controller 是 Flutter 最常見的記憶體洩漏來源之一。**

**`onChanged` vs `controller` 怎麼選？**

- 只需要「使用者打字時拿到值」→ `onChanged` 就夠，最輕量。
- 需要「主動讀/寫/清空、預填、跨多欄位一起送出」→ 用 `controller`。
- **登入/註冊這類正式表單，通常用 controller**（要在送出時一次讀所有欄位）。

---

## 7.2 Form + TextFormField：整批驗證的正規做法

零散的 TextField 各驗各的很亂。Flutter 提供 `Form` 把一組輸入框「圈起來」，一次驗證、一次送出。

```dart
class LoginForm extends StatefulWidget {
  const LoginForm({super.key});
  @override
  State<LoginForm> createState() => _LoginFormState();
}

class _LoginFormState extends State<LoginForm> {
  final _formKey = GlobalKey<FormState>();          // 1) 表單的遙控器
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  void _submit() {
    // 3) 觸發所有欄位的 validator；全部通過才回 true
    if (_formKey.currentState!.validate()) {
      final email = _emailController.text.trim();
      final pwd = _passwordController.text;
      print('驗證通過，送出：$email / $pwd');
      // 這裡之後會呼叫 Riverpod 的登入邏輯（第 08、10 章）
    }
  }

  @override
  Widget build(BuildContext context) {
    return Form(
      key: _formKey,                                // 2) 把 key 綁上 Form
      child: Column(
        children: [
          TextFormField(
            controller: _emailController,
            decoration: const InputDecoration(labelText: 'Email'),
            keyboardType: TextInputType.emailAddress,
            validator: (value) {                     // 4) 每個欄位的驗證規則
              if (value == null || value.isEmpty) return 'Email 不能空白';
              if (!value.contains('@')) return 'Email 格式不正確';
              return null;                           // 回 null = 通過
            },
          ),
          TextFormField(
            controller: _passwordController,
            decoration: const InputDecoration(labelText: '密碼'),
            obscureText: true,                       // 密碼遮起來顯示 ●●●
            validator: (value) {
              if (value == null || value.length < 6) return '密碼至少 6 碼';
              return null;
            },
          ),
          const SizedBox(height: 16),
          ElevatedButton(onPressed: _submit, child: const Text('登入')),
        ],
      ),
    );
  }
}
```

逐段解釋（這是**正式表單的標準骨架**，要熟到能默寫）：

- **`final _formKey = GlobalKey<FormState>();`**：表單的「遙控器」。透過它你能對整個 Form 下指令（驗證、儲存、重置）。`GlobalKey` 是第 03 章 key 的一種，作用是「讓你從外面抓到某個 Widget 的 State」。
- **`Form(key: _formKey, child: ...)`**：把一組欄位包進 Form，並綁上 key。
- **`TextFormField`**：是 `TextField` 的「表單版」——多了一個 `validator`，且會自動跟所在的 `Form` 連動。
- **`validator: (value) { ... return null; }`**：每個欄位的驗證規則。**回傳 `null` 代表通過；回傳字串代表錯誤訊息（會自動紅字顯示在欄位下方）**。這個「null=過、字串=錯」的約定要記住。
- **`_formKey.currentState!.validate()`**：**一次觸發所有欄位的 validator**。只要有一個回傳字串，整體就 `false`，且該欄位顯示紅字。全部過才回 `true`。
- **`obscureText: true`**：密碼欄位把輸入遮成圓點。
- **`keyboardType: TextInputType.emailAddress`**：叫系統彈出「適合 email 的鍵盤」（有 @ 鍵）。其他常用：`.number`（數字）、`.phone`（電話）、`.multiline`（多行）。

**心智模型**：`Form` 是「一群欄位的指揮官」，`_formKey` 是你跟指揮官溝通的對講機。喊一聲 `validate()`，所有士兵（欄位）各自報告「我合格嗎」，全合格才放行。

---

## 7.3 即時驗證 vs 送出時驗證

上面是「按送出才驗證」。有時想「邊打邊驗」（例如即時提示密碼強度）。用 `autovalidateMode`：

```dart
Form(
  key: _formKey,
  autovalidateMode: AutovalidateMode.onUserInteraction,  // 使用者動過之後就即時驗證
  child: /* ... */,
)
```

- **`AutovalidateMode.disabled`**（預設）：只有呼叫 `validate()` 才驗。
- **`AutovalidateMode.onUserInteraction`**：使用者**碰過該欄位後**，邊打邊驗（體驗較好，又不會一進畫面就滿江紅）。**推薦用這個。**
- **`AutovalidateMode.always`**：一直驗（一進畫面空欄位就紅，通常太兇）。

---

## 7.4 焦點與鍵盤管理：FocusNode 與「下一個」

好的表單體驗：打完 email 按鍵盤的「下一步」自動跳到密碼欄、打完密碼按「完成」直接送出。

```dart
class _LoginFormState extends State<LoginForm> {
  final _passwordFocus = FocusNode();          // 密碼欄的焦點控制器

  @override
  void dispose() {
    _passwordFocus.dispose();                  // 同樣要 dispose
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        TextFormField(
          textInputAction: TextInputAction.next,        // 鍵盤右下角顯示「下一步」
          onFieldSubmitted: (_) {
            _passwordFocus.requestFocus();              // 按下後把焦點移到密碼欄
          },
        ),
        TextFormField(
          focusNode: _passwordFocus,                    // 綁定焦點控制器
          textInputAction: TextInputAction.done,        // 顯示「完成」
          onFieldSubmitted: (_) => _submit(),           // 按完成直接送出
        ),
      ],
    );
  }
}
```

逐段解釋：

- **`FocusNode`**：控制「焦點在哪個欄位」的物件（一樣要 dispose）。
- **`textInputAction`**：決定鍵盤右下角那顆鍵長怎樣（`next` 下一步、`done` 完成、`search` 搜尋、`send` 送出）。
- **`onFieldSubmitted`**：使用者按下鍵盤那顆動作鍵時觸發。配合 `requestFocus()` 做「自動跳下一欄」。

**收起鍵盤**（點空白處關鍵盤，很常見的需求）：

```dart
GestureDetector(
  onTap: () => FocusScope.of(context).unfocus(),   // 點畫面任意處 → 取消所有焦點 → 收鍵盤
  child: Scaffold(/* ... */),
)
```

- **`FocusScope.of(context).unfocus()`**：取消當前焦點，鍵盤就會收起來。包一層 `GestureDetector` 偵測點擊。

---

## 7.5 把表單接上 Riverpod（實務做法）

上面用 `StatefulWidget` + controller 是基礎做法，完全夠用。但當「表單狀態要跨頁、送出邏輯複雜（呼叫 API）」時，把**送出邏輯**交給 Riverpod 會更乾淨。常見分工：

- **輸入框的文字** → 還是用 controller 在 UI 端管（這是純 UI 的事）。
- **送出 / 提交狀態（loading、成功、失敗）** → 交給 Riverpod 的 AsyncNotifier。

```dart
// login_controller.dart
@riverpod
class LoginController extends _$LoginController {
  @override
  FutureOr<void> build() {}                  // 初始：沒有進行中的提交

  Future<void> login(String email, String password) async {
    state = const AsyncLoading();            // 1) 進入載入中
    state = await AsyncValue.guard(() async {// 2) guard 自動把成功/例外包成 AsyncValue
      final repo = ref.read(authRepositoryProvider);
      await repo.login(email, password);     // 真正打 API（第 10 章建 repo）
    });
  }
}
```

逐段解釋：

- **`AsyncNotifier`（回傳 `FutureOr<void>`）**：管「提交這個動作」的狀態，而不是某個資料。狀態是 `AsyncValue<void>`——代表「沒在做 / 做中 / 成功 / 失敗」。
- **`state = const AsyncLoading();`**：手動切到載入中，UI 就能 disable 按鈕、顯示轉圈。
- **`AsyncValue.guard(() async {...})`**：**超好用**。它幫你跑那段 async 程式，**成功就包成 `AsyncData`、丟例外就自動包成 `AsyncError`**——你不用自己寫 try/catch 再手動 set state。

UI 端：

```dart
class LoginScreen extends ConsumerWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final loginState = ref.watch(loginControllerProvider);

    // 用 listen 處理「成功導頁 / 失敗彈窗」這種一次性副作用（第 06 章）
    ref.listen(loginControllerProvider, (prev, next) {
      if (next is AsyncError) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('登入失敗：${next.error}')),
        );
      } else if (next is AsyncData && prev is AsyncLoading) {
        context.go('/home');                  // 成功 → 跳首頁
      }
    });

    final isLoading = loginState.isLoading;
    return /* ... 你的表單 ... */ ElevatedButton(
      onPressed: isLoading ? null : () {       // 載入中時 disable，避免重複送出
        ref.read(loginControllerProvider.notifier).login(email, pwd);
      },
      child: isLoading
          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
          : const Text('登入'),
    );
  }
}
```

逐段解釋：

- **`isLoading ? null : ...`**：第 04 章說過「onPressed 給 null＝按鈕變灰」。送出中把按鈕關掉，**防止使用者連點重複送出**——這是常被忽略但很重要的 UX。
- **`ref.listen` 處理成功/失敗**：導頁、彈窗是一次性副作用，用 listen（第 06 章的規則）。
- 按鈕內容隨 `isLoading` 切換成轉圈——使用者知道「正在處理」。

**心智模型**：UI（controller 管文字）負責「收集輸入」，Riverpod（AsyncNotifier）負責「送出這件事的狀態」。分工清楚，邏輯好測（第 13 章可以單獨測 LoginController 不用畫面）。

---

## 7.6 常見輸入元件補充

```dart
// 開關
Switch(value: isOn, onChanged: (v) => setState(() => isOn = v))

// 勾選框
Checkbox(value: checked, onChanged: (v) => ...)

// 下拉選單
DropdownButton<String>(
  value: selected,
  items: ['台北', '台中', '高雄']
      .map((c) => DropdownMenuItem(value: c, child: Text(c)))
      .toList(),
  onChanged: (v) => setState(() => selected = v),
)

// 滑桿
Slider(value: volume, min: 0, max: 100, onChanged: (v) => ...)
```

- 共同模式：**`value`（目前值）+ `onChanged`（值變的回呼）**。這就是第 03 章「事件→改狀態→重建」閉環在各種輸入元件上的體現。把 `value` 接到 Riverpod 或 State，`onChanged` 裡更新它。

---

## 7.7 動手練習

1. 做一個註冊表單：email、密碼、確認密碼。`validator` 要驗「兩次密碼一致」（提示：確認密碼的 validator 裡比對 `_passwordController.text`）。
2. 加上 `autovalidateMode: onUserInteraction`，體驗即時驗證。
3. 加上焦點管理：email 按「下一步」跳密碼，密碼按「完成」送出，點空白處收鍵盤。
4. 把送出邏輯改用 Riverpod 的 `AsyncNotifier` + `AsyncValue.guard`，用 `Future.delayed` 模擬 API，送出中按鈕顯示轉圈並 disable，成功後 print「註冊成功」。

---

## 小結

- 取得輸入值兩條路：`onChanged`（輕量，打字時拿值）vs `TextEditingController`（主動讀寫/預填/批次送出）。**controller 一定要 dispose。**
- 正式表單骨架：`Form` + `GlobalKey<FormState>` + `TextFormField` 的 `validator`（**null=過、字串=錯**），用 `_formKey.currentState!.validate()` 一次驗證。
- `autovalidateMode: onUserInteraction` 做體驗最好的即時驗證。
- 焦點與鍵盤：`FocusNode` + `textInputAction` + `onFieldSubmitted` 做「下一步/完成」，`FocusScope.of(context).unfocus()` 收鍵盤。
- 接 Riverpod：UI 用 controller 管文字，**送出狀態交給 AsyncNotifier + `AsyncValue.guard`**，loading 時 disable 按鈕防重複送出，成功/失敗用 `ref.listen`。

---

> 表單收集到資料後，要送去後端、也要把後端資料拿回來。下一章進入「跟世界連線」：用 Dio + Retrofit 串接網路 API。
> 前往 [第 08 章：網路 API 串接（Dio + Retrofit）](./08-networking-dio-retrofit.md)。
