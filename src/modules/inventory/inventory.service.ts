import {
  Injectable, NotFoundException, ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { parse } from 'csv-parse/sync';
import { Vehicle, VehicleDocument } from './schemas/vehicle.schema';
import { CreateVehicleDto, UpdateVehicleDto, VehicleQueryDto } from './dto/vehicle.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class InventoryService {
  constructor(@InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>) {}

  async create(dto: CreateVehicleDto, userId: string): Promise<VehicleDocument> {
    const exists = await this.vehicleModel.findOne({ vehicleNumber: dto.vehicleNumber.toUpperCase() });
    if (exists) throw new ConflictException(`Vehicle number ${dto.vehicleNumber} already exists`);

    const vehicle = new this.vehicleModel({ ...dto, addedBy: userId });
    return vehicle.save();
  }

  async findAll(query: VehicleQueryDto): Promise<PaginatedResult<VehicleDocument>> {
    const { page = 1, limit = 20, search, sort = '-createdAt', status, company, model,
      minPrice, maxPrice, minYear, maxYear, fuelType, transmission } = query;
    const skip = (page - 1) * limit;

    const filter: FilterQuery<VehicleDocument> = { isDeleted: false };
    if (status) filter.status = status;
    if (company) filter.company = { $regex: company, $options: 'i' };
    if (model) filter.model = { $regex: model, $options: 'i' };
    if (fuelType) filter.fuelType = fuelType;
    if (transmission) filter.transmission = transmission;
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.price = {};
      if (minPrice !== undefined) filter.price.$gte = minPrice;
      if (maxPrice !== undefined) filter.price.$lte = maxPrice;
    }
    if (minYear !== undefined || maxYear !== undefined) {
      filter.year = {};
      if (minYear !== undefined) filter.year.$gte = minYear;
      if (maxYear !== undefined) filter.year.$lte = maxYear;
    }
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { model: { $regex: search, $options: 'i' } },
        { vehicleNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const sortObj: any = {};
    if (sort.startsWith('-')) sortObj[sort.slice(1)] = -1;
    else sortObj[sort] = 1;

    const [data, total] = await Promise.all([
      this.vehicleModel.find(filter).sort(sortObj).skip(skip).limit(limit).populate('addedBy', 'firstName lastName email').lean(),
      this.vehicleModel.countDocuments(filter),
    ]);

    return new PaginatedResult(data as VehicleDocument[], total, page, limit);
  }

  async findById(id: string): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel
      .findOne({ _id: id, isDeleted: false })
      .populate('addedBy', 'firstName lastName email');
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    // Increment view count
    await this.vehicleModel.findByIdAndUpdate(id, {
      $inc: { 'traffic.views': 1 },
      $set: { 'traffic.lastViewed': new Date() },
    });

    return vehicle;
  }

  async update(id: string, dto: UpdateVehicleDto, userId: string): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel.findOne({ _id: id, isDeleted: false });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    // Track history
    const historyEntries = Object.entries(dto)
      .filter(([key, value]) => vehicle[key] !== value)
      .map(([field, value]) => ({
        field,
        value: String(vehicle[field]),
        newValue: String(value),
        changedAt: new Date(),
        changedBy: userId,
      }));

    const updated = await this.vehicleModel.findByIdAndUpdate(
      id,
      { $set: dto, $push: { history: { $each: historyEntries } } },
      { new: true, runValidators: true },
    );

    return updated;
  }

  async addImages(id: string, filePaths: string[]): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $push: { photos: { $each: filePaths } } },
      { new: true },
    );
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  async softDelete(id: string): Promise<void> {
    const vehicle = await this.vehicleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true, deletedAt: new Date() },
    );
    if (!vehicle) throw new NotFoundException('Vehicle not found');
  }

  async getHistory(id: string): Promise<any[]> {
    const vehicle = await this.vehicleModel.findOne({ _id: id, isDeleted: false }).select('history');
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle.history || [];
  }

  async getTraffic(id: string): Promise<any> {
    const vehicle = await this.vehicleModel.findOne({ _id: id, isDeleted: false }).select('traffic vehicleNumber title');
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle.traffic;
  }

  async bulkUpload(csvBuffer: Buffer, userId: string): Promise<{ created: number; errors: string[] }> {
    const records = parse(csvBuffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const errors: string[] = [];
    let created = 0;

    for (const record of records) {
      try {
        await this.create(
          {
            vehicleNumber: record.vehicleNumber,
            title: record.title || `${record.year} ${record.company} ${record.model}`,
            company: record.company,
            model: record.model,
            year: parseInt(record.year),
            kmDriven: parseInt(record.kmDriven || '0'),
            price: parseFloat(record.price),
            discountPercent: parseFloat(record.discountPercent || '0'),
            ownerCount: parseInt(record.ownerCount || '1'),
            fuelType: record.fuelType,
            transmission: record.transmission,
            color: record.color,
            description: record.description,
          },
          userId,
        );
        created++;
      } catch (err) {
        errors.push(`Row ${record.vehicleNumber || '?'}: ${err.message}`);
      }
    }

    return { created, errors };
  }

  async getStats(): Promise<any> {
    const [total, sold, unsold, pending, avgPrice] = await Promise.all([
      this.vehicleModel.countDocuments({ isDeleted: false }),
      this.vehicleModel.countDocuments({ status: 'sold', isDeleted: false }),
      this.vehicleModel.countDocuments({ status: 'unsold', isDeleted: false }),
      this.vehicleModel.countDocuments({ status: 'pending', isDeleted: false }),
      this.vehicleModel.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: null, avg: { $avg: '$price' } } },
      ]),
    ]);

    return { total, sold, unsold, pending, avgPrice: avgPrice[0]?.avg || 0 };
  }
}
