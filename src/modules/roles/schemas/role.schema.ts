import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { AppModule, PermissionAction } from '../../../common/permissions';

export type RoleDocument = Role & Document;

@Schema({ timestamps: true, collection: 'roles' })
export class Role {
  @Prop({ required: true, unique: true, trim: true })
  name: string;

  @Prop({ default: '' })
  description: string;

  @Prop({
    type: [
      {
        module: { type: String, enum: Object.values(AppModule), required: true },
        actions: [{ type: String, enum: Object.values(PermissionAction) }],
      },
    ],
    default: [],
  })
  permissions: { module: AppModule; actions: PermissionAction[] }[];

  /** True for seeded default roles. Blocks deletion via the API. */
  @Prop({ default: false })
  isSystem: boolean;

  @Prop({ default: false })
  isDeleted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const RoleSchema = SchemaFactory.createForClass(Role);
