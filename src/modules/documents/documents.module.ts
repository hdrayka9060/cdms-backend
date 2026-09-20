import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentTemplate, DocumentTemplateSchema } from './schemas/document-template.schema';
import { BuyerDocument, BuyerDocumentSchema } from './schemas/buyer-document.schema';
import { DocumentTemplatesController } from './document-templates.controller';
import { BuyerDocumentsController } from './buyer-documents.controller';
import { DocumentTemplatesService } from './document-templates.service';
import { BuyerDocumentsService } from './buyer-documents.service';
import { PdfStampService } from './pdf-stamp.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentTemplate.name, schema: DocumentTemplateSchema },
      { name: BuyerDocument.name, schema: BuyerDocumentSchema },
    ]),
  ],
  // Templates controller MUST be first: its static `/documents/templates` route
  // registers before BuyerDocuments' `/documents/:id`, so it isn't captured as :id.
  controllers: [DocumentTemplatesController, BuyerDocumentsController],
  providers: [DocumentTemplatesService, BuyerDocumentsService, PdfStampService],
  exports: [BuyerDocumentsService, DocumentTemplatesService],
})
export class DocumentsModule {}
