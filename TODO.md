# TODO — Backlog de LeadPilot

> Archivo de referencia interna. Claude lo lee al empezar sesiones nuevas para mantener
> el hilo del backlog entre conversaciones. Actualizar aquí en vez de solo mencionar
> pendientes en el chat. Para arquitectura, comandos y gotchas operativos, ver
> [`CLAUDE.md`](CLAUDE.md) — este archivo es solo el backlog/historial de decisiones.

## Pendiente

### 1. Volver a exigir solo patrocinados (revertir el filtro relajado)
Contexto: el 2026-07-05 se relajó a propósito el filtro de `serpapi-provider.ts` para
generar volumen mientras Pablo estaba de vacaciones (ver sección "Decisiones temporales"
abajo). Sigue pendiente decidir:
- Si gosom ya está arreglado (ver ítem #1 de "Bugs externos pendientes"): usarlo como
  fuente principal, ya filtra mejor por naturaleza (aunque tampoco distingue patrocinado
  de orgánico — ver nota).
- Si se sigue con SerpApi: en [`packages/functions/scrape-worker/serpapi-provider.ts`](packages/functions/scrape-worker/serpapi-provider.ts),
  quitar la rama que ingiere `local_results.places` (orgánicos) y volver a exigir
  únicamente `local_ads.ads` (patrocinados, `sponsored: true`).
- Nota importante: **ninguno de los 2 scrapers expone "patrocinado" como propiedad simple
  del objeto de Google Maps** — gosom no distingue en absoluto; SerpApi solo lo distingue
  vía `local_ads.ads` del motor `google` (no `google_maps`), y ni así es perfecto (el
  anuncio no trae el sitio web propio, hay que cruzarlo por nombre contra `local_results`,
  y frecuentemente no hay coincidencia).
- **Alternativa evaluada (2026-07-21, no implementada aún)**: en vez de depender de que
  un scraper marque "patrocinado", detectar directamente en el sitio del lead si tiene
  instalado el tag de conversión de Google Ads (patrón `AW-` en el HTML, o script de
  `googleads.g.doubleclick.net`). Es la misma señal real que se busca ("está pagando por
  publicidad"), se puede agregar gratis al fetch que ya se hace para extraer el email
  (`findEmailOnWebsite` en `serpapi-provider.ts` / el equivalente en `gosom-provider.ts`),
  y no depende de ninguno de los 2 scrapers. Contra: detecta que el tag está instalado,
  no que la campaña esté activa hoy (puede haber falsos positivos de campañas viejas sin
  desactivar) — aun así, margen de error más chico que la heurística actual de SerpApi.

## Mejoras de AI engineering (portfolio + calidad real) — evaluado 2026-07-26

LeadPilot ya es un caso de estudio real de producción con LLMs (pipeline con criterio de
costo por tarea, datos reales, no un notebook de Kaggle) — pero le faltan piezas
específicas del vocabulario/prácticas de "AI engineering" para funcionar como caso
defendible en entrevista. No son cosmética: la #1 en particular resuelve un problema que
ya mordió al proyecto (ver más abajo). Orden de prioridad acordado con Pablo, de mayor a
menor señal/esfuerzo:

1. **Evals** (siguiente paso elegido). Set de 20-30 casos con criterio de éxito medible
   por código o por un segundo call de Claude como juez — no "lo probé y parece que anda".
   Caso de prueba real ya disponible: el bug de las 4 prompts (`generate-report`,
   `regenerate-email`, footer de follow-ups) que asumían que el negocio paga por Google
   Ads sin ninguna evidencia — encontrado y arreglado a mano el 2026-07-25 tras un reporte
   de Pablo, no por ningún proceso sistemático. Un eval con un criterio tipo "¿el email
   menciona ads sin que `webAnalysis`/`sponsored` lo respalde?" lo hubiera atrapado antes
   de llegar a producción. Construir el set sobre datos reales ya en DynamoDB
   (`webAnalysis` + `emailBody`/`emailSubject` de leads existentes), no sintéticos.

2. **Prompt versioning + logging estructurado**. Hoy cero trazabilidad: ningún registro de
   qué prompt/versión/modelo generó qué output, sin costo ni latencia capturados, en
   ninguno de los 5 sitios de llamada a Claude (`generate-report/index.ts` ×3 — reporte,
   email, LinkedIn —, `regenerate-email/index.ts` ×2, `shared/followup-email.ts` vía
   `followup-sequencer`/`simulate-followup`). Tabla DynamoDB chica
   (`promptId`, `version`, `model`, `inputSummary`, `output`, `tokensIn/Out`, `costUsd`,
   `latencyMs`, `at`) alcanza. Prerequisito real del ítem 1: sin esto no se pueden comparar
   variantes de prompt de forma rigurosa.

3. **Tool use / function calling**. Formalizar como tool calls con output estructurado dos
   decisiones que hoy son heurística ad-hoc en el código, no algo que decida el LLM con
   criterio explícito:
   - Señal de "el negocio paga por publicidad" — sigue sin resolverse de forma confiable,
     ver ítem 1 de "Pendiente" arriba y la alternativa evaluada (detectar tag `AW-` en el
     sitio).
   - Clasificación bot-vs-humano de un click de email — hoy es análisis manual de
     timestamps (caso real: el flujo de unsubscribe del 2026-07-24, donde se identificó a
     mano que 7 de 10 "engaged" eran en realidad escáneres de seguridad corporativos por el
     timing entre click y unsubscribe, no por ningún clasificador).

4. **RAG real** (no "Pinecone como key-value store"). Embeddings + retrieval semántico
   sobre los leads existentes (~80, con `webAnalysis` estructurado y resultado real:
   SENT/ENGAGED/BOOKED) para, al generar el email de un lead nuevo, recuperar los 2-3 leads
   pasados más similares que sí generaron engagement e inyectar su ángulo como few-shot.
   Volumen bajo hoy — tener lista la justificación de "por qué vector search y no un query
   SQL directo a esta escala" para cuando lo pregunten en entrevista.

## Completado (2026-07-21)

Estos 4 puntos, pedidos junto con el ítem 1 de arriba, ya están implementados y
desplegados (a propósito se dejó pendiente solo el ítem 1, sponsored-only, a pedido
explícito de Pablo):

- **Categorías del pipeline manual eliminadas**: se quitaron `REVIEWING`, `CALLED`,
  `RESPONDED`, `NO_RESPONSE`, `CLOSED` de `LeadStatus` (en `shared/types.ts` y
  `frontend/types/lead.ts`), del nav (`App.tsx`), de `StatusBadge.tsx`, de
  `VALID_TRANSITIONS` (`update-lead-status/index.ts`), y de los `ALLOWED` sets en
  `trigger-analysis`/`trigger-report`. `QUALIFIED` y `DISCARDED` se mantuvieron en el
  enum (son estados internos reales del pipeline / tienen 1 lead histórico), simplemente
  ya no tienen UI manual asociada — el gate manual "Calificar/Descartar" en
  `LeadDetail.tsx` (ligado a `REVIEWING`, que nunca se alcanza porque `ingest-leads`
  auto-califica todo) se eliminó por ser dead code.
  `followup-sequencer`'s umbral final (`FOLLOWUP_2` sin respuesta tras 28 días) ahora
  transiciona a `ARCHIVED` en vez de a `NO_RESPONSE` (que ya no existe).
- **Dashboard como página principal**: `/` → `Dashboard`, la lista de leads se movió a
  `/leads`. Todos los links internos actualizados (`LeadCard`, `LeadDetail`, `AddLead`,
  `ScrapeLeads`).
- **Seguimiento por llamada eliminado**: botones "Registrar llamada", "Respondió",
  "✓ Cerrar deal" fuera de `LeadDetail.tsx`. El seguimiento automático por email
  (`FOLLOWUP_1`/`FOLLOWUP_2`, `followup-sequencer`) no se tocó — es un sistema distinto.
- **Link de Google Calendar eliminado**: `generateCalendarLink()` (`generate-report/index.ts`)
  y `buildCalendarLink()` (`ResourcesPanel.tsx`) removidas, junto con el campo
  `calendarLink` del tipo `LeadItem`. La reserva real por Cal.com (`calcom-webhook`,
  estado `BOOKED`) no se tocó — son sistemas distintos, solo se quitó el recordatorio
  manual secundario.

Verificado en producción (build + deploy limpios, sin errores de tipos, probado en
el navegador contra el sitio real): nav muestra solo Analizados/Enviados/Archivados,
ficha de lead sin botones de llamada ni link de calendario, dashboard es la home.

## Resuelto (2026-07-21)

**Corte de crédito de Anthropic (15–21 de julio)**: Pablo recargó saldo y activó recarga
automática. Se forzó manualmente (`POST /leads/{id}/report`) la generación de los 6
leads reales que habían quedado atascados en `ANALYZED` durante el corte (Sundial
Locksmith, All Fence Co, All Degrees HVAC, Skyline Pressure Washing, Albuquerque Fence
Company, Mechanical Technologies) — los 6 generaron reporte, enviaron email y publicaron
LinkedIn correctamente. El cron diario debería seguir funcionando solo de acá en más.

**Gosom**: confirmado arreglado upstream (`v1.16.2`/`v1.16.3`, PR "Fix playwright driver
install 404 error", sube `playwright-go` a `v0.6000.0`). Ver "Bugs externos" abajo —
ya no es un bloqueante técnico para volver a usarlo, queda como decisión de producto.

**Nota aparte, sin resolver**: hay un lote de ~17 leads viejos ("dentist" en Austin, del
2026-07-02) atascados en `ANALYZED` con reporte ya generado pero **sin ningún email
capturado** (`email` y `emails` vacíos) — no es el mismo problema, no se pueden forzar
porque no hay a quién enviarles nada. `sendLeadEmail` los descarta silenciosamente
(`no-recipients`, sin loguear nada al timeline). Si se quieren rescatar, hay que
añadirles un email a mano (botón "+ Añadir" en la ficha del lead) antes de poder
reintentar el envío.

## Completado (2026-07-21, sesión screenshot/análisis)

Se investigó por qué un lead (`HomeFound Real Estate Group Boise`) nunca tuvo análisis de
Claude. Cadena de 4 problemas reales, todos arreglados:

1. **Timeout de 25s muy ajustado** para el fetch HTTP al screenshot-service — algunos
   sitios (fuentes web lentas) tardan más. Subido a 60s
   ([`analysis-worker/index.ts`](packages/functions/analysis-worker/index.ts), función
   `requestScreenshot`).
2. **La imagen de Docker del screenshot-service en ECR estaba desactualizada** (del
   2026-07-02) — nunca se había reconstruido después de agregar `resizeIfTooLarge()`
   (fix de un límite de Claude: máximo 8000px por dimensión en la imagen). Por eso
   páginas largas seguían mandando screenshots sin redimensionar y Claude las rechazaba.
3. **Al reconstruir la imagen, se subió para la plataforma equivocada** (amd64) dos veces
   seguidas — la tarea de Fargate del screenshot-service está pineada a
   `ecs.CpuArchitecture.ARM64` en `scraping.ts`. Un `docker build --platform amd64` (o
   sin flag, en un Mac Apple Silicon) produce una imagen que Fargate no puede ni
   descargar (`CannotPullContainerError`), y el fallo se manifiesta primero como un
   timeout confuso ("Timeout esperando que la tarea de captura llegue a RUNNING") antes
   de que ECS reporte el error real. **Comando correcto, documentado también en
   `CLAUDE.md`:**
   ```
   docker buildx build --platform linux/arm64 -t <ecr-uri>:latest --push packages/screenshot-service
   ```
   Verificar con `docker manifest inspect <imagen>` → `"architecture": "arm64"` antes de
   dar por bueno un rebuild.
4. **Margen de arranque de la tarea ECS** (60s → 120s en `waitForPublicIp`) — la imagen
   nueva pesa más (~730MB con las dependencias de `sharp`) y a veces tarda más en
   arrancar en frío.

Verificado end-to-end: el lead de prueba ya tiene `webAnalysis` y `screenshotS3Key`
completos. Este era un problema de infraestructura (imagen vieja + timeouts ajustados +
arquitectura equivocada), no algo específico de ese lead — debería beneficiar a
cualquier análisis futuro, sobre todo de sitios con carga lenta.

## Limpieza pendiente (menor, no urgente)

- **Parámetro SSM huérfano**: `/leadpilot/followup-daily-cap` existe en SSM (valor `10`)
  pero ningún código lo lee — el parámetro real es `/leadpilot/daily-send-cap` (wireado a
  `SHARED_DAILY_CAP_PARAM`, valor `20`). Confirmar y borrar el huérfano para no confundir
  a futuro.
- **`packages/screenshot-service` no tiene ningún paso de build/push en CI ni en
  `cdk deploy`** — es la única pieza del stack que se despliega completamente a mano
  (ver `CLAUDE.md`). Si esto se vuelve a olvidar, va a volver a pasar el mismo bug del
  punto 2 de arriba. Vale la pena automatizarlo (ej. un script `npm run deploy` en ese
  workspace, o un `DockerImageAsset` de CDK que build+pushee automáticamente en cada
  `cdk deploy` — este último cambiaría el flujo actual de ECR manual).

## Decisiones temporales (revertir o revisar)

- **`/leadpilot/scrape-provider` = `serpapi`** (SSM). Gosom está roto por un bug externo
  (ver abajo) — cuando se arregle, decidir si se vuelve a gosom o se queda en SerpApi
  permanentemente.
- **Filtro relajado en SerpApi** (orgánicos + patrocinados, no solo patrocinados) — ver
  ítem 1 arriba. Como contraparte: los leads orgánicos son más fríos que los
  patrocinados (no hay señal de "está invirtiendo en su presencia digital"), así que la
  tasa de respuesta probablemente sea menor mientras este filtro siga relajado — normal,
  no es una regresión.

## Bugs externos pendientes (no dependen de nosotros)

1. **Gosom — el bug original ya está arreglado, pero apareció uno nuevo, más grave, el
   2026-07-21.**
   - El bug original (driver `1.57.0` eliminado del CDN) sí lo arreglaron: `v1.16.2`
     (13/7) sube `playwright-community/playwright-go` a `v0.6000.0` (driver `1.60.0`)
     correctamente. Pero **`v1.16.2` no tiene imagen publicada en Docker Hub** (solo el
     tag de git) — no se puede usar directamente.
   - `v1.16.3` (la única imagen disponible además de versiones viejas) **introduce una
     regresión propia**: su Dockerfile pre-instala el driver vía un paquete distinto
     (`mxschmitt/playwright-go@v0.6100.0`, driver `1.61.1`) en `/opt/ms-playwright-go`,
     pero el binario de la app en realidad usa `playwright-community/playwright-go@v0.6000.0`
     (driver `1.60.0`) — mismatch real, error en runtime: `"driver exists but version
     not 1.60.0"`. Ya se pinneó la imagen a `v1.16.3` y se agregó un override de
     `PLAYWRIGHT_DRIVER_PATH` en [`scraping.ts`](packages/infra/lib/constructs/scraping.ts)
     para forzar una descarga limpia en vez de usar el driver mal instalado — esta parte
     del fix es correcta y quedó desplegada.
   - **Pero al forzar esa descarga limpia (2026-07-21), la propia CDN de Microsoft
     (`playwright.azureedge.net`) devolvió 404 para TODAS las versiones probadas
     (1.58.x–1.64.x), no solo la vieja `1.57.0`.** El dominio ahora redirige (307) a
     `playwright.download.prss.microsoft.com/dbazure/download/playwright/`, un sistema
     de distribución distinto que devuelve 400/404 con errores tipo
     `GatewayServiceFileDetails Response is not in success state` — parece una migración
     de infraestructura de Microsoft en curso, no algo que dependa de gosom ni de
     nosotros. **Conclusión: gosom sigue sin poder usarse hoy, por una razón nueva y
     totalmente fuera de nuestro control.** La config actual (`v1.16.3` +
     `PLAYWRIGHT_DRIVER_PATH` override) es la correcta — si el CDN de Microsoft se
     estabiliza, debería empezar a funcionar sin tocar nada más. Revisar de nuevo más
     adelante probando `curl -I https://playwright.azureedge.net/builds/driver/playwright-1.61.1-linux.zip`.
   - `/leadpilot/scrape-provider` se dejó en `serpapi` (la única opción que funciona hoy).

## Sugerencias técnicas (no pedidas explícitamente, para evaluar)

- **Monitorear reputación de envío en SES** mientras el filtro esté relajado (leads más
  fríos = probablemente más rebotes/quejas). Si sube la tasa de bounce, vale la pena
  cortar antes de que afecte la entregabilidad general del dominio. SES en sí está sano
  (producción activa en `eu-west-1`, dominio e email verificados, 50k/día de cupo).
- **Cuota de SerpApi**: quedan ~200 de 250 búsquedas del plan free (al 2026-07-21). El
  cron diario gasta 1 por corrida — a este ritmo alcanza de sobra, pero si se corre el
  scraper manualmente muchas veces conviene vigilarlo.
- **Registro de coincidencia patrocinado↔sitio** (`findWebsiteByName` en
  `serpapi-provider.ts`) es una heurística por solapamiento de palabras, no un ID estable.
  Funciona pero es aproximada — si en el futuro se vuelve crítico (ítem 1), documentar
  mejor sus falsos negativos conocidos (ads que no matchean por diferencias grandes de
  naming) en vez de asumir que todo ad sin match es "sin sitio real".
