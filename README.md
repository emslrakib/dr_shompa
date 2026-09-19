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
| **Admin / CMS** | http://localhost:5000/admin |
| Health check | http://localhost:5000/api/health |

> ⚠️ এই PC-তে PowerShell Execution Policy `npm.ps1` ব্লক করে, তাই `npm start` কাজ করবে না।
> `node server.js` বা `npm.cmd start` ব্যবহার করুন, অথবা একবার চালান:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

দ্বিতীয় চালানোর জন্য `npm install` লাগবে না (dependencies ইনস্টল করা আছে)। নতুন মেশিনে প্রথমে `npm.cmd install`।

---

## ⚙️ কনফিগারেশন (`\.env`)

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
| `ADMIN_USER` | *(খালি)* | সেট করলে admin প্যানেল লক হবে |
| `ADMIN_PASS` | *(খালি)* | উপরের সাথে মিলিয়ে দিন |

ডাটাবেস প্রথমবার তৈরি করতে: `setup_db.sql` SQL Server-এ চালান (তables + sample data সহ)।

---

## 🔌 API রেফারেন্স

| Method | Endpoint | কাজ |
|---|---|---|
| GET | `/api/health` | সার্ভার + DB স্ট্যাটাস (public) |
| POST | `/api/appointments` | নতুন বুকিং (public) |
| GET | `/api/appointments` | সব অ্যাপয়েন্টমেন্ট (`?status=&date=&search=`) — admin |
| PATCH | `/api/appointments/:id` | স্ট্যাটাস বদলানো (Pending/Confirmed/Completed/Cancelled) — admin |
| DELETE | `/api/appointments/:id` | অ্যাপয়েন্টমেন্ট মুছে ফেলা — admin |
| GET | `/api/stats` | ড্যাশবোর্ড কাউন্ট — admin |
| GET | `/api/cms/content` | সাইটের সব কনটেন্ট (settings/services/testimonials/qualifications) (public) |
| PUT | `/api/cms/settings` | সাইট সেটিংস আপডেট — admin |
| GET/POST/PUT/DELETE | `/api/cms/services[/:id]` | সার্ভিস CRUD — admin |
| GET/POST/PUT/DELETE | `/api/cms/testimonials[/:id]` | রোগীর মতামত CRUD — admin |
| GET/PUT | `/api/cms/qualifications[/:id]` | About কার্ড — admin |

সব রেসপন্স JSON: সফল হলে `{ "success": true, ... }`, ব্যর্থ হলে `{ "success": false, "message": "..." }`।

---

## 🔒 নিরাপত্তা / Security

- **`/admin` প্যানেলে কোনো পাসওয়ার্ড নেই** এবং `/api/appointments` দিয়ে রোগীর নাম, বয়স, ফোন নম্বর পড়া যায়।
  শুধু নিজের কম্পিউটারে চালালে সমস্যা নেই, কিন্তু **ইন্টারনেটে হোস্ট করলে অবশ্যই** `.env`-এ `ADMIN_USER` + `ADMIN_PASS` সেট করুন
  (তখন `/admin`, `/api/stats`, রোগীর ডেটা ও কনটেন্ট এডিট Basic auth দিয়ে সুরক্ষিত হবে; পাবলিক সাইট ও বুকিং ফর্ম খোলা থাকবে)।
- `.env` কখনো git-এ কমিট করবেন না (`.gitignore`-এ আছে)।
- সার্ভার `server.js`, `db.js`, `package.json`, `.env`, লগ/ডাম্প ফাইল ব্রাউজারে serve করে না।
- প্রোডাকশনে `DB_ENCRYPT=true` ব্যবহার করা ভালো।

---

## 🧯 সমস্যা হলে / Troubleshooting

| সমস্যা | কারণ / সমাধান |
|---|---|
| `npm.ps1 cannot be loaded` | PowerShell policy — `node server.js` ব্যবহার করুন |
| `EADDRINUSE :5000` | আগের সার্ভার চalu আছে — বন্ধ করুন অথবা `.env`-এ `PORT` বদলান |
| সাইট খোলে কিন্তু ডেটা আসে না | API test করুন: http://localhost:5000/api/health — `database: unavailable` এলে SQL Server/`.env` চেক করুন |
| `Database is unavailable` (503) | SQL Server সার্ভিস চালু আছে কিনা (`Get-Service MSSQLSERVER`) ও `.env` credentials দেখুন |
| `Failed to fetch` admin প্যানেলে | সার্ভার চালু নেই, অথবা অন্য পোর্টে চালু আছে |

> সার্ভার DB ছাড়াও চালু থাকে এবং পরের রিকোয়েস্টে নিজে থেকেই আবার connect করার চেষ্টা করে,
> তাই SQL Server পরে চালু হলেও সার্ভার restart করা লাগে না।

---

## 🗂️ প্রজেক্ট স্ট্রাকচার

```
server.js                  Express API + static hosting + security guards
db.js                      mssql connection pool (lazy, auto-retry)
setup_db.sql               ডাটাবেস + টেবিল + sample data
dr-arefin-zannat-sompa.html  পাবলিক ওয়েবসাইট
patient-voices.html        রোগীর মতামত পেজ
admin.html                 CMS অ্যাডমিন প্যানেল
*.jpg / *.png              ছবি
.env / .env.example        কনফিগারেশন (`.env` গোপন)
start.cmd                  এক ক্লিকে সার্ভার চালু
```

## 🧰 Tech stack

Node.js (24.x) · Express 4 · mssql 10 · dotenv · cors · vanilla HTML/CSS/JS (frameworks নেই) · SQL Server

## 📌 Git

```powershell
git log --oneline      # history দেখুন
git status             # কী বদলেছে দেখুন
git diff               # বিস্তারিত পরিবর্তন
```
