# ⚡ Pablómetro — AEMET Weather App

> El tiempo oficial de la **AEMET**, pero con buen gusto. **Puro vibecode**: una aplicación meteorológica ultraligera, minimalista y adaptativa diseñada bajo los principios de **Material Design 3**.

---

## ✨ Características Principales

* **Puro Vibecode:** Desarrollo ágil, código limpio y directo, con una estética visual cuidada al milímetro para la experiencia del día a día.
* **100% Gratuito y Sostenible:** Arquitectura *serverless* que no requiere servidores de pago ni mantenimiento complejo.
* **Caché Inteligente en el Edge:** Proxy intermediario en Cloudflare Workers para evitar bloqueos CORS, proteger las credenciales y aplicar caché perimetral (TTL de 2 horas) evitando saturar la API oficial.
* **Diseño Material Design 3:** Componentes adaptativos, colores tonales de superficie, esquinas redondeadas y tipografía limpia, con experiencia *mobile-first* impecable y total compatibilidad con PC.
* **Geolocalización y Búsqueda por INE:** Resolución eficiente de municipios sin depender de APIs de pago externas.

---

## 🏗️ Arquitectura del Sistema

El proyecto está dividido en dos piezas desacopladas que se comunican de forma segura:

1. **Frontend (GitHub Pages):** Aloja los archivos estáticos (`index.html`, `app.js`, `manifest.json`) consumiendo de manera directa el proxy.
2. **Backend Serverless (Cloudflare Worker):** Actúa como pasarela (BFF), realiza la consulta en dos fases requerida por la API de AEMET, normaliza el caótico JSON original a un DTO limpio y gestiona la caché perimetral.

```
[Navegador / PWA] ──(fetch /?ine=...)──▶ [Cloudflare Worker (Caché Edge)] ──▶ [AEMET OpenData API]
```

---

## 🛠️ Tecnologías empleadas
* **HTML5 & Tailwind CSS** (para la maquetación MD3 y utilidades).
* **JavaScript Moderno (Vanilla JS)** sin dependencias pesadas.
* **Cloudflare Workers & Cache API** para el servidor proxy sin coste.
* **AEMET OpenData API** como fuente oficial de datos meteorológicos de España.
* **Gemini** Pro 3.1 y Argon 4 como modelos de IA.
