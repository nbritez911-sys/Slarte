# Slarte

Backend inicial para el sistema de mensajería de Slarte.

## Funciones incluidas

- Registro e inicio de sesión mediante `@username`.
- Perfil con nombre, foto por URL y descripción.
- Sesiones persistentes con cookie HttpOnly.
- Contraseñas con hash bcrypt.
- Búsqueda de usuarios.
- Conversaciones privadas.
- Grupos y miembros.
- Historial de mensajes.
- WebSocket para mensajes, presencia y estado de escritura.
- SQLite con WAL para mantener el backend ligero.

## Ejecutar localmente

```bash
npm install
npm start
```

El servidor usa `PORT` si Render la proporciona; localmente usa `10000`.

WebSocket:

```text
ws://localhost:10000/ws
```

En producción:

```text
wss://TU-DOMINIO/ws
```

## Eventos WebSocket

Cliente -> servidor:

```json
{"type":"typing","conversation_id":1,"active":true}
```

Servidor -> cliente:

```json
{"type":"typing","conversation_id":1,"user":{},"active":true}
```

```json
{"type":"presence","user":{}}
```

```json
{"type":"message","message":{}}
```

## Persistencia en Render

SQLite necesita almacenamiento persistente si se quiere conservar la base de datos entre reinicios/despliegues. En Render se debe montar un Persistent Disk y definir:

```text
DATABASE_PATH=/ruta/montada/slarte.db
```

Para una primera prueba pequeña también se puede ejecutar sin disco, teniendo presente que la base local no debe considerarse persistente.

## Próxima capa

La interfaz web puede consumir esta API y WebSocket para construir una experiencia tipo WhatsApp/Instagram sin usar números telefónicos.
