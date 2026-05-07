import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ApiProperty } from '@nestjs/swagger';

export type VehicleDocument = Vehicle & Document;

export enum VehicleStatus {
  PENDING = 'pending',
  UNSOLD = 'unsold',
  SOLD = 'sold',
}

export enum HostingType {
  SELF = 'self',
  PLATFORM = 'platform',
}

export enum FuelType {
  PETROL = 'petrol',
  DIESEL = 'diesel',
  ELECTRIC = 'electric',
  HYBRID = 'hybrid',
  CNG = 'cng',
}

export enum Transmission {
  MANUAL = 'manual',
  AUTOMATIC = 'automatic',
  CVT = 'cvt',
}

@Schema({ timestamps: true })
class TrafficLog {
  @Prop({ default: 0 }) views: number;
  @Prop({ default: 0 }) clicks: number;
  @Prop({ default: 0 }) inquiries: number;
  @Prop({ type: Date }) lastViewed: Date;
}

@Schema({ timestamps: true, collection: 'vehicles' })
export class Vehicle {
  @ApiProperty() @Prop({ required: true, unique: true, uppercase: true, trim: true }) vehicleNumber: string;
  @ApiProperty() @Prop({ required: true, trim: true }) title: string;
  @ApiProperty() @Prop({ default: '' }) description: string;
  @ApiProperty() @Prop({ type: [String], default: [] }) photos: string[];
  @ApiProperty() @Prop({ required: true }) company: string;
  @ApiProperty() @Prop({ required: true }) model: string;
  @ApiProperty() @Prop({ required: true, min: 1900, max: 2100 }) year: number;
  @ApiProperty() @Prop({ default: 0, min: 0 }) kmDriven: number;
  @ApiProperty() @Prop({ required: true, min: 0 }) price: number;
  @ApiProperty() @Prop({ default: 0, min: 0, max: 100 }) discountPercent: number;
  @ApiProperty() @Prop({ default: 1, min: 1 }) ownerCount: number;
  @ApiProperty({ enum: FuelType }) @Prop({ type: String, enum: FuelType }) fuelType: FuelType;
  @ApiProperty({ enum: Transmission }) @Prop({ type: String, enum: Transmission }) transmission: Transmission;
  @ApiProperty() @Prop({ default: '' }) color: string;
  @ApiProperty() @Prop({ default: '' }) vin: string;
  @ApiProperty({ enum: VehicleStatus }) @Prop({ type: String, enum: VehicleStatus, default: VehicleStatus.PENDING }) status: VehicleStatus;
  @ApiProperty({ enum: HostingType }) @Prop({ type: String, enum: HostingType, default: HostingType.PLATFORM }) hosting: HostingType;
  @ApiProperty() @Prop({ type: [String], default: [] }) features: string[];
  @ApiProperty() @Prop({ type: [{ field: String, value: String, changedAt: Date, changedBy: String }], default: [] }) history: any[];
  @ApiProperty() @Prop({ type: TrafficLog, default: {} }) traffic: TrafficLog;
  @ApiProperty() @Prop({ type: Types.ObjectId, ref: 'User' }) addedBy: Types.ObjectId;
  @ApiProperty() @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const VehicleSchema = SchemaFactory.createForClass(Vehicle);

VehicleSchema.index({ status: 1, company: 1, model: 1 });
VehicleSchema.index({ price: 1 });
VehicleSchema.index({ vehicleNumber: 1 });
VehicleSchema.index({ '$**': 'text' }, { name: 'vehicle_text_index' });
