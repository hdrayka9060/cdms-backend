import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type FacebookListingTemplateDocument = FacebookListingTemplate & Document;

/**
 * A reusable listing template. `titleTemplate` / `descriptionTemplate` may
 * contain `{{var}}` placeholders ({{year}}, {{make}}, {{model}}, {{trim}},
 * {{price}}, {{km}}, {{vin}}, {{color}}, {{title}}) which are substituted
 * per-vehicle at compose time (substitution happens client-side, where the
 * vehicle data already lives).
 */
@Schema({ timestamps: true, collection: 'facebook_listing_templates' })
export class FacebookListingTemplate {
  @Prop({ required: true }) name: string;
  @Prop({ default: '' }) titleTemplate: string;
  @Prop({ default: '' }) descriptionTemplate: string;
  @Prop({ default: '' }) defaultLocation: string;
  @Prop({ default: '' }) defaultContact: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  createdBy: Types.ObjectId;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const FacebookListingTemplateSchema = SchemaFactory.createForClass(
  FacebookListingTemplate,
);
