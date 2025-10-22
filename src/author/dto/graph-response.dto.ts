import { ApiProperty } from '@nestjs/swagger';
import { DimensionType } from '../../common/types/enums';

export class GraphNode {
  @ApiProperty({
    description: 'Crux ID',
    example: 'be464476-892a-40f5-b26b-ee340f060c72',
  })
  id: string;

  @ApiProperty({
    description: 'Crux title',
    example: 'What is Crux Garden?',
  })
  name: string;

  @ApiProperty({
    description: 'Crux slug',
    example: 'what-is-crux-garden',
  })
  slug: string;

  @ApiProperty({
    description: 'Crux type',
    example: 'markdown',
    required: false,
  })
  type?: string;

  @ApiProperty({
    description: 'Crux status',
    example: 'living',
    required: false,
  })
  status?: string;
}

export class GraphLink {
  @ApiProperty({
    description: 'Source crux ID',
    example: 'be464476-892a-40f5-b26b-ee340f060c72',
  })
  source: string;

  @ApiProperty({
    description: 'Target crux ID',
    example: 'e350f0df-50b1-421f-8e13-9debf1b7a676',
  })
  target: string;

  @ApiProperty({
    description: 'Dimension type',
    enum: DimensionType,
    example: DimensionType.GARDEN,
  })
  type: DimensionType;
}

export class GraphResponseDto {
  @ApiProperty({
    description: 'Graph nodes (cruxes)',
    type: [GraphNode],
  })
  nodes: GraphNode[];

  @ApiProperty({
    description: 'Graph links (dimensions)',
    type: [GraphLink],
  })
  links: GraphLink[];
}
