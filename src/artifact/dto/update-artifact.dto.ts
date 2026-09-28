import { PartialType, PickType } from '@nestjs/swagger';
import { CreateArtifactDto } from './create-artifact.dto';

/** Ownership and file facts are assigned by the server, never by a metadata edit. */
export class UpdateArtifactDto extends PartialType(
  PickType(CreateArtifactDto, ['type', 'kind', 'meta', 'filename'] as const),
) {}

/** File facts come from a validated upload, after the request DTO has been checked. */
export type ArtifactUpdate = UpdateArtifactDto &
  Partial<
    Pick<CreateArtifactDto, 'encoding' | 'mimeType' | 'filename' | 'size'>
  >;
