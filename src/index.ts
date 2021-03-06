import http from 'http'
import express from 'express'
import { Server } from 'socket.io'
import { createAdapter } from 'socket.io-redis'
import { StatsD } from 'node-statsd'
import pino from 'pino'
import pinoHttp from 'pino-http'
import dotenv from 'dotenv'

dotenv.config()

enum Events {
  userJoin = 'user-join',
  userLeave = 'user-leave',
  userList = 'user-list',
  newRoomData = 'new-room-data',
}

enum Metrics {
  usersCount = 'users_count',
  usersActive = 'users_active',
  roomsCount = 'rooms_count',
  roomsActive = 'rooms_active',
  roomsSize = 'rooms_size',
  roomsJoinCount = 'rooms_join_count',
  roomsLeaveCount = 'rooms_leave_count',
  roomsBroadcastDataCount = 'rooms_broadcast_data_count',
  roomsBroadcastDataLength = 'rooms_broadcast_data_length',
  roomsBroadcastVolatileDataCount = 'rooms_broadcast_volatile_data_count',
  roomsBroadcastVolatileDataLength = 'rooms_broadcast_volatile_data_length',
  errorsCount = 'errors_count',
}

const port = process.env.PORT || 80
const corsOrigin = process.env.CORS_ORIGIN || undefined
const redisUri = process.env.REDIS_URI || undefined
const statsdHost = process.env.STATSD_HOST || undefined
const statsdPort = process.env.STATSD_PORT
  ? parseInt(process.env.STATSD_PORT)
  : 8125

const logger = pino()

const stats = new StatsD(statsdHost, statsdPort)

const app = express()
app.use((req, res, next) => {
  if (req.header('X-CleverCloud-Monitoring') === 'telegraf') {
    return res.sendStatus(200)
  }
  next()
})
app.use(pinoHttp())

const server = http.createServer(app)
server.listen(port, () => {
  logger.info(`Server started on port ${port}`)
})

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

if (redisUri) {
  logger.info('Enabling Socket-IO Redis adapter')
  io.adapter(createAdapter(redisUri))
}

io.on('connection', async (socket) => {
  stats.increment(Metrics.usersCount)

  const ids = await io.sockets.allSockets()
  stats.gauge(Metrics.usersActive, ids.size)

  socket.on('error', () => {
    stats.increment(Metrics.errorsCount)
  })

  socket.on('disconnect', async () => {
    const ids = await io.sockets.allSockets()
    stats.gauge(Metrics.usersActive, ids.size)
  })

  socket.on('join-room', async (room: string) => {
    // if (!(room in io.sockets.adapter.rooms)) {
    //   // NOTE: this will not work properly with redis-adapter
    //   // ideally, should call io.sockets.adapter.allRooms()
    //   // https://github.com/socketio/socket.io-redis#redisadapterallroomsfnfunction
    //   stats.increment(Metrics.roomsCount)
    // }

    socket.join(room)
    socket.to(room).emit(Events.userJoin, socket.id)

    const ids = await io.in(room).allSockets()
    io.in(room).emit(Events.userList, [...ids])

    stats.gauge(Metrics.roomsSize, ids.size)
    stats.increment(Metrics.roomsJoinCount)
  })

  socket.on('leave-room', async (room: string) => {
    socket.leave(room)
    socket.to(room).emit(Events.userLeave, socket.id)

    const ids = await io.in(room).allSockets()
    io.in(room).emit(Events.userList, [...ids])

    stats.gauge(Metrics.roomsSize, ids.size)
    stats.increment(Metrics.roomsLeaveCount)
  })

  socket.on('broadcast-room-data', (room: string, encryptedData: string) => {
    socket.to(room).emit(Events.newRoomData, encryptedData)

    stats.increment(Metrics.roomsBroadcastDataCount)
    stats.gauge(Metrics.roomsBroadcastDataLength, encryptedData.length)
  })

  socket.on(
    'broadcast-volatile-room-data',
    (room: string, encryptedData: string) => {
      socket.volatile.to(room).emit(Events.newRoomData, encryptedData)

      stats.increment(Metrics.roomsBroadcastVolatileDataCount)
      stats.gauge(
        Metrics.roomsBroadcastVolatileDataLength,
        encryptedData.length
      )
    }
  )
})
