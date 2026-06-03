import {
  WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';

// Mirror the HTTP CORS allow-list for the socket handshake (dev falls back to
// reflecting any origin).
const corsOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : true;

/**
 * Real-time push for staff chat. WRITES still go through the REST controller
 * (validation, permissions, the member guard, file upload all live there); this
 * gateway only pushes server→client events and is the channel the service emits
 * on after a successful DB write. Each authenticated socket joins a personal
 * room `user:<id>`, and the service emits to the rooms of a conversation's
 * active participants — so own-chats-only holds on the socket layer too.
 */
@WebSocketGateway({ cors: { origin: corsOrigins, credentials: true } })
export class MessagingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MessagingGateway.name);
  @WebSocketServer() server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  private room(userId: string): string {
    return `user:${userId}`;
  }

  /** Authenticate the handshake JWT and reject removed/inactive staff. */
  async handleConnection(client: Socket): Promise<void> {
    try {
      const raw =
        (client.handshake.auth as any)?.token ||
        (client.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) throw new Error('missing token');

      const payload: any = this.jwt.verify(raw, { secret: this.config.get('JWT_ACCESS_SECRET') });
      const userId = payload?.sub;
      if (!userId) throw new Error('invalid payload');

      // Same identity check as the HTTP path: a deleted/inactive user can't connect.
      const user = await this.userModel.findOne({ _id: userId, isDeleted: false }).select('_id status');
      if (!user || user.status !== 'active') throw new Error('inactive or removed');

      client.data.userId = String(user._id);
      await client.join(this.room(String(user._id)));
      this.logger.log(`socket connected user=${user._id} sid=${client.id}`);
    } catch (err: any) {
      this.logger.warn(`socket auth rejected sid=${client.id}: ${err?.message}`);
      client.emit('auth_error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    // socket.io cleans up room membership automatically.
  }

  /** Push an event to a set of users (each in their personal room). */
  emitToUsers(userIds: string[], event: string, payload: any): void {
    if (!this.server) return;
    const rooms = [...new Set(userIds.map(String))].map((id) => this.room(id));
    if (rooms.length) this.server.to(rooms).emit(event, payload);
  }

  /** Drop all of a user's live sockets — used when a staff member is removed. */
  disconnectUser(userId: string): void {
    if (!this.server) return;
    this.server.in(this.room(String(userId))).disconnectSockets(true);
  }
}
