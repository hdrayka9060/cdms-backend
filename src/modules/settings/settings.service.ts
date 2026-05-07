import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DealerSettings, DealerSettingsDocument } from './schemas/dealer-settings.schema';

@Injectable()
export class SettingsService {
  constructor(@InjectModel(DealerSettings.name) private model: Model<DealerSettingsDocument>) {}

  async get(): Promise<DealerSettingsDocument> {
    let settings = await this.model.findOne();
    if (!settings) settings = await new this.model({}).save();
    return settings;
  }

  async update(dto: any): Promise<DealerSettingsDocument> {
    let settings = await this.model.findOne();
    if (!settings) {
      settings = await new this.model(dto).save();
      return settings;
    }
    return this.model.findByIdAndUpdate(settings._id, { $set: dto }, { new: true });
  }

  async updateNotifications(dto: any): Promise<DealerSettingsDocument> {
    let settings = await this.model.findOne();
    if (!settings) settings = await new this.model({}).save();
    return this.model.findByIdAndUpdate(settings._id, { $set: { notifications: dto } }, { new: true });
  }
}
