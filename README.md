# Dr. Arefin Zannat Sompa — Website & Appointment System

Consultant Psychiatrist (Sylhet) এর জন্য দ্বিভাষিক (EN/বাংলা) ওয়েবসাইট + অ্যাপয়েন্টমেন্ট বুকিং + সম্পূর্ণ CMS (admin panel)।
A bilingual (EN/Bangla) clinic website with appointment booking and a full CMS admin panel.

---

## 🚀 দ্রুত চালু করুন / Quick start

**সবচেয়ে সহজ — `start.cmd` ফাইলে ডাবল-ক্লিক করুন।** (npm লাগে না)

অথবা টার্মিনালে:

```powershell
cd C:\Users\Hp\Documents\myprojectnew\DrShompa
node server.js
```

শুরু হলে ব্রাউজারে খুলুন:

| Page | URL |
|---|---|
| Public website | http://localhost:5000/ |
| Patient voices | http://localhost:5000/voices |
| **Admin sign-in** | **http://localhost:5000/login** |
| **Admin / CMS** | http://localhost:5000/admin (লগইন ছাড়া ঢুকলে `/login`-এ পাঠাবে) |
| Health check | http://localhost:5000/api/health |

**Admin credentials:** `.env`-এ থাকা `ADMIN_USER` ও `ADMIN_PASS` ব্যবহার করুন। কোনো default password production-এ ব্যবহার করবেন না; deploy করার আগে long, unique password এবং `SESSION_SECRET` সেট করুন। বিস্তারিত: `PRODUCTION_DEPLOYMENT.md`।

> ⚠️ এই PC-তে PowerShell Execution Policy `npm.ps1` ব্লক করে, তাই `npm start` কাজ করবে না।
> `node server.js` বা `npm.cmd start` ব্যবহার করুন, অথবা একবার চালান:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

দ্বিতীয় চালানোর জন্য `npm install` লাগবে না (dependencies ইনস্টল করা আছে)। নতুন মেশিনে প্রথমে `npm.cmd install`।

---

## 🧭 Visual Studio থেকে রান ও পাবলিশ

প্রজেক্টে VS solution যোগ করা আছে — **`DrShompa.slnx`**।
Visual Studio-তে folder-view নয়, এই solution-টাই খুলুন (`File > Open > Project/Solution` → `DrShompa.slnx`),
কেননা folder-view-তে F5 রান বা Publish মেনু থাকে না।

| কাজ | কীভাবে |
|---|---|
| রান (ডিবাগার সহ) | `F5` — `server.js` চালু হয় (পোর্ট 5000), ব্রাউজার নিজে থেকেই খোলে |
| শুধু রান | Node.js debugger-এ সমস্যা হলে `Ctrl+F5` (Start Without Debugging) |
| Publish | Solution Explorer-এ প্রজেক্ট নামে ডান-ক্লিক → **Publish** |

`Properties\PublishProfiles`-এ দুটি profile দেওয়া আছে:

| Profile | কী তৈরি করে |
|---|---|
| `DrShompa-Folder` | `publish\` ফোল্ডারে সোর্স কপি (node_modules ছাড়া) — সার্ভারে কপি করে `npm.cmd ci` চালান |
| `DrShompa-IIS-Package` | `publish\DrShompa.zip` + `DrShompa.deploy.cmd` + `SetParameters.xml` (IIS Manager → Deploy → Import Application) |

> `node_modules` ও `.env` কখনো publish হয় না (`.env`-এ পাসওয়ার্ড থাকে, তাই ইচ্ছাকৃতভাবে বাদ)।
> সার্ভারে প্রথমে `npm.cmd ci`, তারপর `.env`, `npm.cmd run db:migrate` — বিস্তারিত `IIS_DEPLOYMENT.md`-এ।

কমান্ড-লাইন থেকেও একই পাবলিশ করা যায়:

```powershell
$msb = "C:\Program Files\Microsoft Visual Studio\18\Professional\MSBuild\Current\Bin\MSBuild.exe"
& $msb DrShompa.njsproj -t:Build -p:DeployOnBuild=true -p:PublishProfile=DrShompa-IIS-Package -p:Configuration=Release
```

> VS খোলার সময় "migrate to the new JavaScript project system" জিজ্ঞেস করলে **Not now** দিন —
> migrate করলে `DrShompa.njsproj` বদলে যাবে এবং এই রান/পাবলিশ সেটআপ আর কাজ করবে না।

---

## 🗄️ appsettings.json — যেকোনো মেশিনের সেটিং

প্রতিটি মেশিনে শুধু **`appsettings.json`** (server.js-এর পাশে) বদলালেই DB + web connect হয় —
`appsettings.example.json` কপি করে `appsettings.json` বানান (এটি git-ignored, তাই পাসওয়ার্ড কখনো কমিট হয় না)।

| JSON সেকশন | কাজ |
|---|---|
| `Web` | পোর্ট, environment (`Port`, `TrustProxy`, `AllowedOrigins`) |
| `Database` | SQL Server হোস্ট, ডাটাবেস, লগইন (`Server`, `Name`, `User`, `Password`, …) |
| `Admin` | লগইন ইউজার/পাসওয়ার্ড (`User`, `Password`) |
| `Session` | সেশন cookie সাইন করার চাবি (`Secret`) |
| `Reminders` | SMS/SMTP রিমাইন্ডার (`DryRun`, `Sms`, `Smtp`) |

নিয়ম — উপরেরটা জেতে:

1. OS environment variable (IIS service settings, `setx`, docker)
2. `appsettings.json` + `appsettings.<NODE_ENV>.json`
3. `.env` (পুরনো পদ্ধতি — দুটোই থাকলে appsettings.json এটাকে হারায়)

কোন সেটিং দিয়ে চলছে, পাসওয়ার্ড ছাড়াই যেকোনো সময় দেখুন:

```powershell
npm.cmd run config:show
```

সার্ভার চালুর সময়ও console-এ লেখা থাকে, যেমন
`⚙️ Config: appsettings.json | db localhost:1433/DrShompaDB | web http://localhost:5000` —
ভুল মেশিন/DB-তে গেলে এটাই প্রথমে দেখুন।

> 💡 JSON-এ খালি (`""`) রাখা মান = "সেটিং দেওয়া হয়নি" — খালি ফিল্ড কখনো অন্য ফাইলের
> পাসওয়ার্ড মুছে দেয় না। দুই ফাইলে একই সেটিং ভিন্ন থাকলে চালুর সময় লগে লেখা থাকে
> (`appsettings.json overrides .env for: PORT, DB_NAME`) — সুবিধার জন্য এক মেশিনে একটাই ফাইল রাখুন।

---

## ⚙️ কনফিগারেশন (`appsettings.json` / `.env`)

উপরে বর্ণিত appsettings.json-ই নতুন মেশিনে ব্যবহার করুন; নিচের `.env` টেবিলটা পুরনো পদ্ধতির
রেফারেন্স হিসেবে রাখা হলো (`.env` git-ignored)। প্রতিটি JSON সেকশনের পাশে সমতুল্য
`.env` নামটাও মিলিয়ে নিতে পারবেন।

`.env.example` কপি করে `.env` বানান (`.env` git-ignored):

| Variable | ডিফল্ট | বর্ণনা |
|---|---|---|
| `PORT` | `5000` | HTTP পোর্ট |
| `DB_SERVER` | `localhost` | SQL Server হোস্ট |
| `DB_NAME` | `DrShompaDB` | ডাটাবেসের নাম |
| `DB_USER` | — | SQL লগইন |
| `DB_PASSWORD` | — | SQL পাসওয়ার্ড |
| `DB_PORT` | `1433` | SQL Server পোর্ট |
| `DB_ENCRYPT` | `false` | TLS এনক্রিপশন |
| `DB_TRUST_SERVER_CERT` | `true` | self-signed সার্টিফিকেট গ্রহণ |
| `ADMIN_USER` | *(সেট করা আছে: `admin`)* | লগইন ইউজারনেম |
| `ADMIN_PASS` | *(সেট করা আছে)* | লগইন পাসওয়ার্ড |
| `SESSION_SECRET` | auto | সেশন cookie সাইন করার চাবি (না দিলে পাসওয়ার্ড থেকে তৈরি হয়) |

> ⚠️ **`.env` এর ফাঁদ:** মানের ভেতরে `#` থাকলে dotenv সেটাকে comment ভেবে বাদ দেয় —
> `ADMIN_PASS=abc#123` লিখলে পাসওয়ার্ড হবে শুধু `abc`। দরকার হলে ডাবল কোট ব্যবহার করুন:
> `ADMIN_PASS="abc#123"`। উপরের দিকে শুরু/শেষের extra space বাদ দেওয়া হয়।

ডাটাবেস প্রথমবার তৈরি করতে: `setup_db.sql` SQL Server-এ চালান (তables + sample data সহ)।

---

## 🔌 API রেফারেন্স

| Method | Endpoint | কাজ |
|---|---|---|
| GET | `/api/health` | সার্ভার + DB স্ট্যাটাস (public) |
| GET | `/login` | অ্যাডমিন লগইন স্ক্রিন (public) |
| POST | `/api/login` | `{username, password}` → সেশন cookie (public) |
| POST | `/api/logout` | সাইন আউট (সেশন সার্ভারেও বাতিল হয়) |
| GET | `/api/session` | লগইন অবস্থা (`authEnabled`, `authenticated`, `username`) |
| POST | `/api/appointments` | নতুন বুকিং (public) |
| GET | `/api/appointments` | তালিকা — `?status=&search=&date=YYYY-MM-DD&from=YYYY-MM-DD&to=YYYY-MM-DD` — admin |
| PATCH | `/api/appointments/:id` | স্ট্যাটাস বদলানো (Pending/Confirmed/Completed/Cancelled) — admin |
| DELETE | `/api/appointments/:id` | অ্যাপয়েন্টমেন্ট মুছে ফেলা — admin |
| GET | `/api/stats` | ড্যাশবোর্ড কাউন্ট — admin |
| GET | `/api/cms/content` | সাইটের সব কনটেন্ট (settings/services/testimonials/qualifications) (public) |
| PUT | `/api/cms/settings` | সাইট সেটিংস + ছবি/লোগো আপডেট — admin |
| GET/POST/PUT/DELETE | `/api/cms/services[/:id]` | সার্ভিস CRUD — admin |
| GET/POST/PUT/DELETE | `/api/cms/testimonials[/:id]` | রোগীর মতামত CRUD — admin |
| GET/PUT | `/api/cms/qualifications[/:id]` | About কার্ড — admin |

সব রেসপন্স JSON: সফল হলে `{ "success": true, ... }`, ব্যর্থ হলে `{ "success": false, "message": "..." }`।
ভুল তারিখ ফরম্যাট দিলে `400` এবং পরিষ্কার বার্তা আসে। `from`/`to` একসাথে দিলে তারিখ-রেঞ্জ ফিল্টার হয়
(`from` শুধু দিলে >=, `to` শুধু দিলে <=)।

```powershell
# উদাহরণ: ২০ সেপ্টেম্বর ২০২৬-এর সব অ্যাপয়েন্টমেন্ট
# নিজের .env-এর ADMIN_USER এবং ADMIN_PASS বসান
curl -u YOUR_ADMIN_USER:YOUR_ADMIN_PASSWORD "http://localhost:5000/api/appointments?from=2026-09-20&to=2026-09-20"
```

---

## 🔒 নিরাপত্তা / Security

- `/admin` প্যানেল, রোগীর রেকর্ড (নাম, বয়স, ফোন) এবং কনটেন্ট এডিট **লগইন দিয়ে সুরক্ষিত** —
  সাইন ইন না করে ঢুকলে স্বয়ংক্রিয়ভাবে `/login`-এ পাঠানো হয়, আর API কল `401` পায়।
- **পাবলিক ওয়েবসাইট, রোগীর মতামত পেজ, `/api/cms/content` এবং বুকিং ফর্ম (POST) সবার জন্য খোলা থাকে।**
- সেশন cookie: `HttpOnly`, `SameSite=Lax`, ৮ ঘণ্টা মেয়াদ, HMAC দিয়ে সাইন করা। সাইন আউট করলে
  টোকেন সার্ভারেও বাতিল হয় (শুধু ব্রাউজার থেকে মুছে যায় না)। স্ক্রিপ্ট/curl-এর জন্য HTTP Basic-ও চলে।
- লগইন বন্ধ করতে চাইলে `.env`-এ `ADMIN_USER` ও `ADMIN_PASS` খালি করে দিন (তখন প্যানেল আবার খোলা)।
- লগইন স্ক্রিনে ভুল পাসওয়ার্ড দিলে সাধারণ বার্তা দেখায় (ইউজারনেম আছে কিনা বলা হয় না)।
- `.env` কখনো git-এ কমিট করবেন না (`.gitignore`-এ আছে)।
- সার্ভার `server.js`, `db.js`, `package.json`, `.env`, লগ/ডাম্প ফাইল ব্রাউজারে serve করে না।
- প্রোডাকশনে `DB_ENCRYPT=true` ব্যবহার করা ভালো।

---

## 🧯 সমস্যা হলে / Troubleshooting

| সমস্যা | কারণ / সমাধান |
|---|---|
| `npm.ps1 cannot be loaded` | PowerShell policy — `node server.js` ব্যবহার করুন |
| `EADDRINUSE :5000` | আগের সার্ভার চালু আছে — `stop.cmd` চালান বা `appsettings.json`-এর `Web:Port` বদলান |
| সাইট খোলে কিন্তু ডেটা আসে না | API test করুন: http://localhost:5000/api/health — `database: unavailable` এলে `appsettings.json`-এর `Database` সেকশন চেক করুন |
| `Database is unavailable` (503) | SQL Server সার্ভিস চালু আছে কিনা (`Get-Service MSSQLSERVER`) ও `appsettings.json`-এর `Database` সার্ভার/নাম/লগইন দেখুন |
| `Failed to fetch` admin প্যানেলে | সার্ভার চালু নেই, অথবা অন্য পোর্টে চালু আছে |
| লগইনে `Wrong username or password` | ⚠️ `.env`-এ পাসওয়ার্ডে `#` থাকলে dotenv বাকি অংশ comment ভেবে কেটে ফেলে — কোট ব্যবহার করুন বা `#` বাদ দিন |
| লগইনে ঢুকতে পারছেন না | `.env` ফাইলে `ADMIN_USER`/`ADMIN_PASS` দেখুন, বদলালে সার্ভার রিস্টার্ট দিন |
| তারিখ ফিল্টারে কিছুই আসে না | Status ফিল্টারও সাথে কাজ করে — ডিফল্টভাবে "All Statuses" থাকে; `Today`/`Next 7 days` বাটন দিয়ে রেঞ্জ বাছুন, `Reset` দিয়ে সব শর্ত মুছুন |
| ছবি আপলোড হচ্ছে না | সেশনের মেয়াদ শেষ হতে পারে (৮ ঘণ্টা) — লগআউট করে আবার লগইন করুন; ছবি ৮ MB-র নিচে রাখুন (ব্রাউজার নিজেই ছোট/compress করে) |
| তারিখ/সময় একদিন সরে দেখাচ্ছে | ঠিক করা হয়েছে — এখন তারিখ `YYYY-MM-DD` থেকে সরাসরি পড়া হয়, timezone-এ সরে যায় না |

> সার্ভার DB ছাড়াও চালু থাকে এবং পরের রিকোয়েস্টে নিজে থেকেই আবার connect করার চেষ্টা করে,
> তাই SQL Server পরে চালু হলেও সার্ভার restart করা লাগে না।

---

## 🗂️ প্রজেক্ট স্ট্রাকচার

```
server.js                  Express API + static hosting + security guards + login/session
db.js                      mssql connection pool (lazy, auto-retry)
setup_db.sql               ডাটাবেস + টেবিল + sample data
dr-arefin-zannat-sompa.html  পাবলিক ওয়েবসাইট
config.js                  appsettings.json-ভিত্তিক কনফিগারেশন লোডার
patient-voices.html        রোগীর মতামত পেজ
admin.html                 CMS অ্যাডমিন প্যানেল (তারিখ-রেঞ্জ ফিল্টার, ছবি আপলোড, লগআউট বাটন)
login.html                 অ্যাডমিন লগইন স্ক্রিন
*.jpg / *.png              ছবি
appsettings.json           মেশিনের সেটিং (DB + web, গোপন — git-ignored)
appsettings.example.json   সেটিং টেমপ্লেট (কমেন্টসহ)
.env / .env.example        পুরনো পদ্ধতির কনফিগারেশন (`.env` গোপন — optional)
start.cmd / stop.cmd       সার্ভার চালু / বন্ধ (এক ক্লিকে)
DrShompa.slnx              VS solution — এটিই খুলে F5 / Publish করুন
DrShompa.njsproj           VS Node.js প্রজেক্ট (startup file = server.js)
Properties\PublishProfiles  VS publish profile (Folder / IIS package)
```

## 🧰 Tech stack

Node.js (24.x) · Express 4 · mssql 10 · dotenv · cors · vanilla HTML/CSS/JS (frameworks নেই) · SQL Server

## 📌 Git

```powershell
git log --oneline      # history দেখুন
git status             # কী বদলেছে দেখুন
git diff               # বিস্তারিত পরিবর্তন
```
