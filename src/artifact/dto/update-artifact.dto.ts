import { PartialType } from '@nestjs/swagger';
import { CreateArtifactDto } from './create-artifact.dto';

export class UpdateArtifactDto extends PartialType(CreateArtifactDto) {}
